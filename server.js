#!/usr/bin/env node
'use strict'; /*jslint node:true es9:true*/
import 'dotenv/config';
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import axios from 'axios';
import {tools as browser_tools} from './browser_tools.js';
import {createRequire} from 'node:module';
import {appendFileSync, readFileSync, writeFileSync, existsSync, statSync} from 'fs';
import http from 'http';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const package_json = require('./package.json');
let api_token = process.env.API_TOKEN;
const unlocker_zone = process.env.WEB_UNLOCKER_ZONE || 'mcp_unlocker';
const browser_zone = process.env.BROWSER_ZONE || 'mcp_browser';
const pro_mode = process.env.PRO_MODE === 'true';
const http_port = parseInt(process.env.HTTP_PORT || '3000', 10);
const transport_type = process.env.TRANSPORT_TYPE || 'stdio'; // 'stdio' or 'http'
const debug_log_to_file = process.env.DEBUG_LOG_TO_FILE === 'true';
const debug_log_file = process.env.DEBUG_LOG_FILE;
const debug_log_file_max_size_mb = parseInt(process.env.DEBUG_LOG_FILE_MAX_SIZE_MB || '50', 10);
const pro_mode_tools = [
    'search_engine', 
    'get_page_previews', 
    'get_page_content_range',
    'grep_page_content',
    'web_data_reddit_posts',
    'web_data_youtube_comments',
    'web_data_youtube_profiles', 
    'web_data_apple_app_store',
    'web_data_google_play_store',
    'web_data_tiktok_posts',
    'web_data_tiktok_profiles',
    'web_data_youtube_videos',
    'web_data_x_posts',
    'web_data_instagram_posts',
    'web_data_instagram_reels',
    'web_data_instagram_comments',
    'web_data_instagram_profiles'
];
function parse_rate_limit(rate_limit_str) {
    if (!rate_limit_str) 
        return null;
    
    const match = rate_limit_str.match(/^(\d+)\/(\d+)([mhs])$/);
    if (!match) 
        throw new Error('Invalid RATE_LIMIT format. Use: 100/1h or 50/30m');
    
    const [, limit, time, unit] = match;
    const multiplier = unit==='h' ? 3600 : unit==='m' ? 60 : 1;
    
    return {
        limit: parseInt(limit),
        window: parseInt(time) * multiplier * 1000, 
        display: rate_limit_str
    };
}

const rate_limit_config = parse_rate_limit(process.env.RATE_LIMIT);

if (!api_token && transport_type !== 'http')
    throw new Error('Cannot run MCP server without API_TOKEN env');
    
if (transport_type === 'http' && !api_token)
    console.error('HTTP mode: API token will be extracted from Authorization header');

const api_headers = (context_token = null)=>({
    'user-agent': `${package_json.name}/${package_json.version}`,
    authorization: `Bearer ${context_token || api_token}`,
});

function check_rate_limit(){
    if (!rate_limit_config) 
        return true;
    
    const now = Date.now();
    const window_start = now - rate_limit_config.window;
    
    debug_stats.call_timestamps = debug_stats.call_timestamps.filter(timestamp=>timestamp>window_start);
    
    if (debug_stats.call_timestamps.length>=rate_limit_config.limit)
        throw new Error(`Rate limit exceeded: ${rate_limit_config.display}`);
    
    debug_stats.call_timestamps.push(now);
    return true;
}

async function ensure_required_zones(){
    try {
        console.error('Checking for required zones...');
        let response = await loggedAxios({
            url: 'https://api.brightdata.com/zone/get_active_zones',
            method: 'GET',
            headers: api_headers(),
        }, 'startup');
        let zones = response.data || [];
        let has_unlocker_zone = zones.some(zone=>zone.name==unlocker_zone);
        let has_browser_zone = zones.some(zone=>zone.name==browser_zone);
        
        if (!has_unlocker_zone)
        {
            console.error(`Required zone "${unlocker_zone}" not found, `
                +`creating it...`);
            await loggedAxios({
                url: 'https://api.brightdata.com/zone',
                method: 'POST',
                headers: {
                    ...api_headers(),
                    'Content-Type': 'application/json',
                },
                data: {
                    zone: {name: unlocker_zone, type: 'unblocker'},
                    plan: {type: 'unblocker'},
                },
            }, 'startup');
            console.error(`Zone "${unlocker_zone}" created successfully`);
        }
        else
            console.error(`Required zone "${unlocker_zone}" already exists`);
            
        if (!has_browser_zone)
        {
            console.error(`Required zone "${browser_zone}" not found, `
                +`creating it...`);
            await loggedAxios({
                url: 'https://api.brightdata.com/zone',
                method: 'POST',
                headers: {
                    ...api_headers(),
                    'Content-Type': 'application/json',
                },
                data: {
                    zone: {name: browser_zone, type: 'browser_api'},
                    plan: {type: 'browser_api'},
                },
            }, 'startup');
            console.error(`Zone "${browser_zone}" created successfully`);
        }
        else
            console.error(`Required zone "${browser_zone}" already exists`);
    } catch(e){
        console.error('Error checking/creating zones:',
            e.response?.data||e.message);
    }
}

// Only ensure zones in stdio mode (HTTP mode will do this per-request)
if (transport_type !== 'http') {
    await ensure_required_zones();
}



let server = new FastMCP({
    name: 'Bright Data',
    version: package_json.version,
    authenticate: transport_type === 'http' ? (request) => {
        // Get the requestId that was set at HTTP level
        const requestId = request.req?._httpRequestId || crypto.randomUUID();
        
        // Always allow requests through, but capture auth info
        const authHeader = request.headers.authorization;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            api_token = token; // Update global token
            return {
                token: token,
                headers: request.headers,
                authenticated: true,
                requestId: requestId,
            };
        }
        
        // No auth provided - allow initialize but mark as unauthenticated
        return {
            token: null,
            headers: request.headers,
            authenticated: false,
            requestId: requestId,
        };
    } : undefined,
});
let debug_stats = {tool_calls: {}, session_calls: 0, call_timestamps: []};

// --- In-memory page cache (10 minutes by default) ---
const PAGE_CACHE_TTL_MS = parseInt(process.env.PAGE_CACHE_TTL_MS || '600000', 10);
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE || '1000', 10);
const pageCache = new Map(); // url -> { content: string, fetchedAt: number }

// Clean up expired cache entries and enforce size limits
function cleanupExpiredCache() {
    const now = Date.now();
    let removedCount = 0;
    
    // Remove expired entries
    for (const [url, cached] of pageCache.entries()) {
        if ((now - cached.fetchedAt) >= PAGE_CACHE_TTL_MS) {
            pageCache.delete(url);
            removedCount++;
        }
    }
    
    // If still too large, remove oldest entries (LRU-style)
    if (pageCache.size > MAX_CACHE_SIZE) {
        const entries = Array.from(pageCache.entries());
        entries.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt); // Sort by age
        
        const toRemove = pageCache.size - MAX_CACHE_SIZE;
        for (let i = 0; i < toRemove; i++) {
            pageCache.delete(entries[i][0]);
            removedCount++;
        }
        console.error(`[Cache] Removed ${toRemove} oldest entries to enforce size limit`);
    }
    
    if (removedCount > 0) {
        console.error(`[Cache] Cleaned up ${removedCount} entries. Cache size: ${pageCache.size}`);
    }
}

// Start cleanup timer (every 2 minutes for more aggressive cleanup)
const cacheCleanupInterval = setInterval(cleanupExpiredCache, 2 * 60 * 1000);

async function fetchMarkdownRaw(url, context_token = null, parentRequestId = null) {
    try {
        let response = await loggedAxios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: unlocker_zone,
                format: 'raw',
                data_format: 'markdown',
            },
            headers: api_headers(context_token),
            responseType: 'text',
        }, parentRequestId);
        return response.data;
    } catch (error) {
        // Add more detailed error information for debugging
        console.error(`[fetchMarkdownRaw] Error fetching ${url}:`, {
            status: error.response?.status,
            statusText: error.response?.statusText,
            message: error.message,
            code: error.code,
            data: error.response?.data
        });
        throw error; // Re-throw to let caller handle it
    }
}

async function getMarkdownWithCache(url, context_token = null, parentRequestId = null) {
    const now = Date.now();
    let cached = pageCache.get(url);
    
    // Immediately remove expired entries to prevent memory leaks
    if (cached && (now - cached.fetchedAt) >= PAGE_CACHE_TTL_MS) {
        console.error(`[Cache EXPIRED] Removing ${url} (age: ${Math.round((now - cached.fetchedAt) / 1000)}s)`);
        pageCache.delete(url);
        // Treat as if no cache entry exists
        cached = null;
    }
    
    if (cached) {
        const ageSeconds = Math.round((now - cached.fetchedAt) / 1000);
        console.error(`[Cache HIT] ${url} (age: ${ageSeconds}s, size: ${pageCache.size})`);
        return { content: cached.content, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    
    console.error(`[Cache MISS] Fetching ${url}`);
    const rawContent = await fetchMarkdownRaw(url, context_token, parentRequestId);
    const strippedContent = stripImageLinks(rawContent); // Strip image links first
    const processedContent = processLongLines(strippedContent); // Process long lines before caching
    const fetchedAt = Date.now();
    pageCache.set(url, { content: processedContent, fetchedAt });
    console.error(`[Cache SET] ${url} (size: ${pageCache.size})`);
    return { content: processedContent, fromCache: false, fetchedAt };
}

function processLongLines(content) {
    const MAX_LINE_LENGTH = 250;
    const originalLines = content.split(/\r?\n/);
    const processedLines = [];
    
    for (const line of originalLines) {
        if (line.length <= MAX_LINE_LENGTH) {
            processedLines.push(line);
        } else {
            // Break long lines into chunks of MAX_LINE_LENGTH
            for (let i = 0; i < line.length; i += MAX_LINE_LENGTH) {
                processedLines.push(line.substring(i, i + MAX_LINE_LENGTH));
            }
        }
    }
    
    return processedLines.join('\n');
}

function getLineRange(content, startLine, endLine) {
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, startLine) - 1; // Convert to 0-indexed
    const end = Math.min(lines.length, endLine);
    
    return {
        content: lines.slice(start, end).join('\n'),
        total_lines: lines.length,
        start_line: startLine,
        end_line: Math.min(endLine, lines.length),
        truncated: end < lines.length,
    };
}

function stripImageLinks(content) {
    // Remove ALL markdown image links (e.g., ![alt text](any-url))
    // This regex matches ![...](any-url) patterns and removes them completely
    return content.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
}

// Clean GitHub-specific boilerplate from markdown content
function cleanGitHubBoilerplate(content, url) {
    // Only apply to GitHub URLs
    if (!url || !url.includes('github.com')) {
        return content;
    }
    
    try {
        let cleaned = content;
        
        // Remove GitHub navigation and UI elements based on actual traffic analysis
        const boilerplatePatterns = [
            // Full navigation menu blocks (from ngrok analysis)
            /## Navigation Menu[\s\S]*?Toggle navigation[\s\S]*?(?=\n\n|Appearance settings|$)/g,
            
            // Large product/feature menus (200+ lines each in ngrok traffic)
            /\*\s+Product\s*\n[\s\S]*?(?=\n\*\s+[A-Z]|\n\*\s+Open|\n\*\s+Solutions|\n\*\s+Resources|\n\*\s+Enterprise|\n\n[A-Z]|\n[A-Za-z].*:|\n\*\*|$)/g,
            /\*\s+Solutions\s*\n[\s\S]*?(?=\n\*\s+[A-Z]|\n\*\s+Open|\n\*\s+Product|\n\*\s+Resources|\n\*\s+Enterprise|\n\n[A-Z]|\n[A-Za-z].*:|\n\*\*|$)/g,
            /\*\s+Resources\s*\n[\s\S]*?(?=\n\*\s+[A-Z]|\n\*\s+Open|\n\*\s+Product|\n\*\s+Solutions|\n\*\s+Enterprise|\n\n[A-Z]|\n[A-Za-z].*:|\n\*\*|$)/g,
            /\*\s+Open Source\s*\n[\s\S]*?(?=\n\*\s+[A-Z]|\n\*\s+Product|\n\*\s+Solutions|\n\*\s+Resources|\n\*\s+Enterprise|\n\n[A-Z]|\n[A-Za-z].*:|\n\*\*|$)/g,
            /\*\s+Enterprise\s*\n[\s\S]*?(?=\n\*\s+[A-Z]|\n\*\s+Open|\n\*\s+Product|\n\*\s+Solutions|\n\*\s+Resources|\n\n[A-Z]|\n[A-Za-z].*:|\n\*\*|$)/g,
            
            // Search interface (from analysis)
            /Search or jump to\.\.\.[\s\S]*?(?=\n# |\nSearch\n|\nClear\n|$)/g,
            /\[Search syntax tips\][\s\S]*?\n/g,
            /# Search code, repositories[\s\S]*?\n/g,
            
            // Footer sections (large in ngrok traffic)
            /## Footer[\s\S]*$/g,
            /### Footer navigation[\s\S]*$/g,
            /\[Terms\]\([^)]*\)[\s\S]*?\[Privacy\][\s\S]*?Do not share my personal information/g,
            
            // Block/Report interface (large section)
            /Block or Report[\s\S]*?# Block or report[\s\S]*?\[Report abuse\]\([^)]*\)/g,
            
            // Authentication and session messages
            /\[Sign in\]\([^)]*\)[\s\S]*?\[Sign up\]\([^)]*\)/g,
            /You signed in with another tab[\s\S]*?Dismiss alert/g,
            /You signed out in another tab[\s\S]*?Dismiss alert/g,
            /You switched accounts on another tab[\s\S]*?Dismiss alert/g,
            /Resetting focus[\s\S]*?Dismiss alert/g,
            
            // Error messages and loading issues
            /(Something went wrong|There was an error while loading)[\s\S]*?(Please reload this page\.|contact support)[\s\S]*?\./g,
            /### Uh oh!\s*\n[\s\S]*?There was an error while loading\. Please reload this page\./g,
            
            // Feedback and help sections
            /# Provide feedback[\s\S]*?Submit feedback/g,
            
            // Saved searches interface
            /# Saved searches[\s\S]*?Create saved search/g,
            
            // Appearance settings
            /Appearance settings[\s\S]*?\n/g,
            
            // Logged-out user prompts
            /You must be logged in to[\s\S]*?\n/g,
            /You can't perform that action[\s\S]*?\n/g,
            
            // GitHub global navigation from main pages
            /\*\s+\[Why GitHub\][\s\S]*?\*\s+\[Documentation\]/g,
            /\*\s+\[Topics\][\s\S]*?\*\s+\[Collections\]/g,
            
            // Site-wide footer links (huge section)
            /## Site-wide Links[\s\S]*$/g,
            /### Subscribe to our developer newsletter[\s\S]*$/g,
            /### Platform[\s\S]*$/g,
            /### Ecosystem[\s\S]*$/g,
            /### Support[\s\S]*$/g,
            /### Company[\s\S]*$/g,
            
            // Social media and language footer
            /\*\s+©\s+\d+\s+GitHub[\s\S]*$/g,
            /\*\s+\[GitHub on LinkedIn\][\s\S]*$/g,
            /English[\s\S]*?日本語.*$/g,
        ];
        
        for (const pattern of boilerplatePatterns) {
            cleaned = cleaned.replace(pattern, '\n\n');
        }
        
        // Clean up multiple newlines and trim
        cleaned = cleaned
            .replace(/\n\n\n+/g, '\n\n')
            .replace(/^\s+|\s+$/g, '')
            .trim();
            
        // Only return cleaned version if it actually removed significant content
        const reductionPercent = (content.length - cleaned.length) / content.length;
        if (reductionPercent > 0.15) { // Only if we removed more than 15%
            console.error(`[GitHub cleaning] Reduced ${url} by ${Math.round(reductionPercent * 100)}% (${content.length} → ${cleaned.length} chars)`);
            return cleaned;
        }
        
        return content;
        
    } catch (error) {
        console.error(`[GitHub cleaning failed for ${url}]:`, error.message);
        return content; // Return original on any error
    }
}

// Extract clean search results from Google SERP content
function extractSerpResults(content, query) {
    try {
        // 1) Remove markdown images (including base64 data URIs)
        const noImages = content.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

        // 2) Capture [title block](https://url) patterns
        const LINK_BLOCK = /\[((?:[^\[\]]|\n)+?)\]\((https?:\/\/[^\s)]+)\)/g;

        const seen = new Map();
        const results = [];
        let match;
        
        while ((match = LINK_BLOCK.exec(noImages)) !== null) {
            const block = match[1];
            let urlStr = match[2];
            
            if (urlStr.startsWith('data:')) continue;

            // 3) Canonicalize & filter URL
            let url;
            try { 
                url = new URL(urlStr); 
            } catch { 
                continue; 
            }
            
            // Skip Google internal links
            if (/(^|\.)google\./i.test(url.hostname)) continue;

            // Strip common tracking params
            const paramsToRemove = ['utm_', 'gclid', 'fbclid', 'ved', 'sa', 'usg', 'ei', 'oq', 'hl', 'source', 'ictx', 'tbm', 'sca_esv', 'ntc', 'aep', 'ptn', 'ver', 'hsh', 'fclid'];
            for (const key of [...url.searchParams.keys()]) {
                for (const param of paramsToRemove) {
                    if (key.startsWith(param)) {
                        url.searchParams.delete(key);
                        break;
                    }
                }
            }
            url.hash = '';
            urlStr = url.toString();

            // 4) Choose reasonable title from the bracket block
            const titleLineMatch =
                block.match(/^###\s+(.+?)\s*$/m) ||       // Prefer "### Title"
                block.match(/^\s*([^\n]{3,200}?)\s*$/m);  // Else first non-empty line
            
            if (!titleLineMatch) continue;

            let title = titleLineMatch[1]
                .replace(/[_*`#]+/g, '')   // Strip markdown emphasis
                .replace(/\s+/g, ' ')     // Normalize whitespace
                .trim();

            if (!title || title.length < 3) continue;
            
            // Deduplicate by URL
            if (!seen.has(urlStr)) {
                seen.set(urlStr, { title, url: urlStr });
                results.push({ title, url: urlStr });
            }
        }

        // Return cleaned results or fallback to original
        if (results.length === 0) {
            return { 
                cleaned: false, 
                content: content,
                note: "No search results could be extracted, returning raw content"
            };
        }

        return {
            cleaned: true,
            results: results,
            original_content_length: content.length,
            cleaned_results_count: results.length,
            note: `Extracted ${results.length} clean search results`
        };
        
    } catch (error) {
        // If cleaning fails, return original content
        console.error(`[SERP cleaning failed for query: ${query}]:`, error.message);
        return { 
            cleaned: false, 
            content: content,
            error: `SERP cleaning failed: ${error.message}`,
            note: "Cleaning failed, returning raw content"
        };
    }
}

function previewText(content, preview_lines, url = null) {
    const MAX_PREVIEW_CHARS = 100000; // 100KB character limit for previews
    
    // Strip out image links first to reduce content size
    let processedContent = stripImageLinks(content);
    
    // Apply GitHub-specific cleaning if applicable
    processedContent = cleanGitHubBoilerplate(processedContent, url);
    
    const lines = processedContent.split(/\r?\n/);
    
    let selectedLines = [];
    let totalChars = 0;
    let lineCount = 0;
    
    // Add lines until we hit line limit OR character limit
    for (const line of lines) {
        if (lineCount >= preview_lines || (totalChars + line.length + 1) > MAX_PREVIEW_CHARS) {
            break;
        }
        selectedLines.push(line);
        totalChars += line.length + 1; // +1 for newline
        lineCount++;
    }
    
    const truncated = lines.length > lineCount;
    
    return {
        preview: selectedLines.join('\n'),
        truncated,
        total_lines: lines.length,
        preview_lines_returned: lineCount,
        preview_chars: totalChars,
        char_limit_reached: totalChars >= MAX_PREVIEW_CHARS - 1000, // Buffer for safety
    };
}

function formatResponseBody(body) {
    if (!body || typeof body !== 'string') return body;
    
    try {
        // Try to parse as JSON and format it nicely
        const parsed = JSON.parse(body);
        return JSON.stringify(parsed, null, 2);
    } catch (e) {
        // If not JSON, check if it's Server-Sent Events format
        if (body.includes('event: message') && body.includes('data: ')) {
            const lines = body.split('\n');
            const formatted = [];
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonData = line.substring(6);
                    try {
                        const parsed = JSON.parse(jsonData);
                        formatted.push('data:');
                        const prettyJson = JSON.stringify(parsed, null, 2);
                        // Indent each line of the JSON
                        const indentedJson = prettyJson.split('\n').map(jsonLine => 
                            '  ' + jsonLine
                        ).join('\n');
                        formatted.push(indentedJson);
                    } catch (e) {
                        formatted.push(line);
                    }
                } else {
                    formatted.push(line);
                }
            }
            return formatted.join('\n');
        }
        
        // Return original if not JSON
        return body;
    }
}

function debugLog(type, data, requestId = null) {
    const logToConsole = debug_log_to_file;
    const logToFile = debug_log_file;
    
    if (!logToConsole && !logToFile) return;
    
    const timestamp = new Date().toISOString();
    
    // For DEBUG_LOG_TO_FILE (legacy format)
    if (logToConsole) {
        const legacyEntry = `[${timestamp}] ${type}: ${JSON.stringify(data, null, 2)}\n\n`;
        try {
            appendFileSync('debug_log', legacyEntry);
        } catch (e) {
            console.error('Failed to write to debug_log:', e.message);
        }
    }
    
    // For DEBUG_LOG_FILE (jq-compatible JSONL format)
    if (logToFile) {
        // Format the data specially if it contains response body
        let formattedData = { ...data };
        if (data.body && typeof data.body === 'string') {
            const formatted = formatResponseBody(data.body);
            // Only truncate if the formatted response is extremely large
            if (formatted.length > 50000) {
                formattedData.body = formatted.substring(0, 50000) + '\n... (truncated for log size)';
            } else {
                formattedData.body = formatted;
            }
        }
        
        // Create jq-compatible JSONL entry (one JSON object per line)
        const logEntry = {
            timestamp,
            type,
            requestId,
            data: formattedData
        };
        
        const jsonlEntry = JSON.stringify(logEntry) + '\n';
        
        try {
            writeDebugLogWithRotation(logToFile, jsonlEntry);
        } catch (e) {
            console.error('Failed to write to debug log file:', e.message);
        }
    }
}

function writeDebugLogWithRotation(filePath, logEntry) {
    const maxSizeBytes = debug_log_file_max_size_mb * 1024 * 1024;
    
    // Check if file exists and its current size
    let currentSize = 0;
    
    if (existsSync(filePath)) {
        const stats = statSync(filePath);
        currentSize = stats.size;
        
        // If adding this entry would exceed the limit, trim the file
        if (currentSize + Buffer.byteLength(logEntry, 'utf8') > maxSizeBytes) {
            try {
                const existingContent = readFileSync(filePath, 'utf8');
                const lines = existingContent.split('\n').filter(line => line.trim().length > 0);
                
                // Only rotate if we have enough content
                if (lines.length > 10) {
                    const removeCount = Math.floor(lines.length * 0.25);
                    const trimmedLines = lines.slice(removeCount);
                    writeFileSync(filePath, trimmedLines.join('\n') + '\n');
                    console.error(`[Debug Log] Rotated log file: removed ${removeCount} old lines from ${filePath}`);
                }
            } catch (rotateError) {
                console.error('Failed to rotate debug log file:', rotateError.message);
                // If rotation fails, just append anyway
            }
        }
    }
    
    // Append the new log entry
    appendFileSync(filePath, logEntry);
}

// Track current request context for console logging
let currentRequestId = null;

// Intercept console output if DEBUG_LOG_FILE is set
if (debug_log_file) {
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    
    console.log = function(...args) {
        originalConsoleLog(...args);
        if (debug_log_file) {
            debugLog('STDOUT', { message: args.join(' ') }, currentRequestId);
        }
    };
    
    console.error = function(...args) {
        // Don't log our own rotation messages to avoid recursion
        const message = args.join(' ');
        if (!message.includes('[Debug Log] Rotated log file')) {
            originalConsoleError(...args);
            if (debug_log_file) {
                debugLog('STDERR', { message }, currentRequestId);
            }
        } else {
            originalConsoleError(...args);
        }
    };
}

// Store request UUIDs for correlation across the request lifecycle  
const requestUuidMap = new Map(); // Maps req object to UUID

// Enhanced HTTP logging wrapper
async function loggedAxios(config, parentRequestId = null) {
    const httpCallId = Math.random().toString(36).substr(2, 9);
    const startTime = Date.now();
    
    // Log the HTTP request if DEBUG_LOG_FILE is set
    if (debug_log_file) {
        debugLog(`HTTP_REQUEST_${httpCallId}`, {
            url: config.url,
            method: config.method,
            headers: config.headers,
            data: config.data,
            params: config.params
        }, parentRequestId);
    }
    
    try {
        const response = await axios(config);
        const duration = Date.now() - startTime;
        
        // Log the HTTP response if DEBUG_LOG_FILE is set
        if (debug_log_file) {
            debugLog(`HTTP_RESPONSE_${httpCallId}`, {
                url: config.url,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                data: typeof response.data === 'string' && response.data.length > 1000 
                    ? response.data.substring(0, 1000) + '... (truncated)' 
                    : response.data,
                duration_ms: duration
            }, parentRequestId);
        }
        
        return response;
    } catch (error) {
        const duration = Date.now() - startTime;
        
        // Log HTTP errors if DEBUG_LOG_FILE is set
        if (debug_log_file) {
            debugLog(`HTTP_ERROR_${httpCallId}`, {
                url: config.url,
                error: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                headers: error.response?.headers,
                data: error.response?.data,
                duration_ms: duration
            }, parentRequestId);
        }
        
        throw error;
    }
}

// Utility function for handling multiple promises with timeout
async function executeWithTimeout(promiseConfigs, timeoutMs = 50000) {
    // promiseConfigs should be array of {promise, timeoutResult} objects
    
    // Create a promise that resolves with timeout error for each individual promise
    const timeoutPromise = (index, config) => new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({
                index,
                status: 'timeout',
                timeoutResult: config.timeoutResult,
            });
        }, timeoutMs);
        
        config.promise.then((result) => {
            clearTimeout(timer);
            resolve({
                index,
                status: 'completed',
                result,
            });
        }).catch((error) => {
            clearTimeout(timer);
            resolve({
                index,
                status: 'error', 
                error,
            });
        });
    });
    
    // Race each promise against its own timeout
    const promisesWithTimeout = promiseConfigs.map((config, index) => 
        timeoutPromise(index, config)
    );
    
    // Wait for all to complete (either with results or timeouts)
    const settledResults = await Promise.all(promisesWithTimeout);
    
    // Return results in original order
    return settledResults.map(result => {
        if (result.status === 'completed') {
            return result.result;
        } else if (result.status === 'timeout') {
            return {
                ...result.timeoutResult,
                status: 'error',
                error: `Request timed out after ${timeoutMs / 1000} seconds`,
                error_details: {
                    message: `Request timed out after ${timeoutMs / 1000} seconds`,
                    type: 'TimeoutError',
                    timeout_ms: timeoutMs,
                }
            };
        } else {
            // Handle the error case from the original promise  
            return result.error;
        }
    });
}

const addTool = (tool) => {
    if (!pro_mode && !pro_mode_tools.includes(tool.name)) 
        return;
    server.addTool(tool);
};

addTool({
    name: 'search_engine',
    description: 'PRIMARY SEARCH TOOL: Execute multiple search queries (max 5) in parallel across Google, Bing, or Yandex. **Batch multiple search queries together** for efficiency instead of making individual requests. Returns SERP results in markdown format (URL, title, description) for each query.',
    parameters: z.object({
        queries: z.array(z.object({
            query: z.string(),
            engine: z.enum(['google', 'bing', 'yandex']).optional().default('google'),
            cursor: z.string().optional().describe('Pagination cursor for next page'),
        })).min(1).max(5),
    }),
    execute: tool_fn('search_engine', async({ queries }, ctx) => {
        const queryPromises = queries.map(async (queryObj) => {
            try {
                const { query, engine = 'google', cursor } = queryObj;
                
                let response = await loggedAxios({
                    url: 'https://api.brightdata.com/request',
                    method: 'POST',
                    data: {
                        url: search_url(engine, query, cursor),
                        zone: unlocker_zone,
                        format: 'raw',
                        data_format: 'markdown',
                    },
                    headers: api_headers(ctx?.session?.token),
                    responseType: 'text',
                }, ctx?.requestId);

                let processedContent = response.data;
                
                // Apply SERP cleaning only for Google searches
                if (engine === 'google') {
                    const cleaned = extractSerpResults(response.data, query);
                    if (cleaned.cleaned) {
                        processedContent = cleaned.results.map(r => `- [${r.title}](${r.url})`).join('\n');
                    }
                    // If cleaning failed or found no results, keep original content
                }

                return {
                    query,
                    engine,
                    cursor,
                    status: 'ok',
                    content: processedContent,
                };
            } catch (error) {
                const errorDetails = {
                    message: error.message || 'Unknown error occurred',
                    type: error.constructor.name || 'Error',
                    status: error.response?.status || null,
                    statusText: error.response?.statusText || null,
                    responseData: error.response?.data || null,
                    code: error.code || null,
                };
                
                return {
                    query: queryObj.query,
                    engine: queryObj.engine || 'google',
                    cursor: queryObj.cursor,
                    status: 'error',
                    error: errorDetails.message,
                    error_details: errorDetails,
                };
            }
        });

        // Execute with 50-second timeout  
        const promiseConfigs = queries.map((queryObj, index) => ({
            promise: queryPromises[index],
            timeoutResult: {
                query: queryObj.query,
                engine: queryObj.engine || 'google',
                cursor: queryObj.cursor,
            }
        }));
        
        const results = await executeWithTimeout(promiseConfigs, 50000);

        return JSON.stringify({
            tool: 'search_engine',
            queries_processed: queries.length,
            results,
            timeout_ms: 50000,
        }, null, 2);
    }),
});


addTool({
    name: 'get_page_previews',
    description: 'PRIMARY TOOL: Fetch multiple URLs (max 10) in parallel and return markdown previews (first 500 lines). When analyzing multiple search results or related pages, batch them together for efficiency. Use heavily - fast, cached (10-minute TTL), designed for frequent use. All lines are max 250 chars each. Use get_page_content_range to get specific line ranges beyond the preview.',
    parameters: z.object({
        urls: z.array(z.string().url()).min(1).max(10),
    }),
    execute: tool_fn('get_page_previews', async ({ urls }, ctx) => {
        const nowISO = new Date().toISOString();
        const urlPromises = urls.map(async (url) => {
            try {
                const { content, fromCache, fetchedAt } = await getMarkdownWithCache(url, ctx?.session?.token);
                const p = previewText(content, 500, url); // Always 500 lines, pass URL for cleaning
                return {
                    url,
                    status: 'ok',
                    from_cache: fromCache,
                    fetched_at: new Date(fetchedAt).toISOString(),
                    start_line: 1,
                    end_line: Math.min(500, p.total_lines),
                    preview_lines: 500,
                    total_lines: p.total_lines,
                    truncated: p.truncated,
                    content: p.preview,
                    note: p.truncated ? `Page has ${p.total_lines} total lines. Use get_page_content_range(url, start_line, end_line) to get lines 501-${p.total_lines}. Max 5000 lines per request.` : "Complete page content shown.",
                };
            } catch (e) {
                const errorDetails = {
                    message: e.message || 'Unknown error occurred',
                    type: e.constructor.name || 'Error',
                    status: e.response?.status || null,
                    statusText: e.response?.statusText || null,
                    responseData: e.response?.data || null,
                    code: e.code || null,
                };
                
                return {
                    url,
                    status: 'error',
                    error: errorDetails.message,
                    error_details: errorDetails,
                };
            }
        });

        // Execute with 50-second timeout
        const promiseConfigs = urls.map((url, index) => ({
            promise: urlPromises[index],
            timeoutResult: {
                url: url,
            }
        }));
        
        const results = await executeWithTimeout(promiseConfigs, 50000);

        return JSON.stringify({
            tool: 'get_page_previews',
            now: nowISO,
            ttl_ms: PAGE_CACHE_TTL_MS,
            max_line_length: 250,
            timeout_ms: 50000,
            results,
        }, null, 2);
    }),
});

addTool({
    name: 'get_page_content_range',
    description: 'RANGE TOOL: Fetch specific line range from a single URL (e.g., lines 501-1000). Requires start_line and end_line parameters. Max 5000 lines per request. Use after get_page_previews to get more content from specific sections. All lines are max 250 chars each.',
    parameters: z.object({
        url: z.string().url(),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1),
    }).refine(data => data.end_line >= data.start_line, {
        message: "end_line must be >= start_line"
    }).refine(data => (data.end_line - data.start_line + 1) <= 5000, {
        message: "Cannot request more than 5000 lines at once"
    }),
    execute: tool_fn('get_page_content_range', async ({ url, start_line, end_line }, ctx) => {
        const { content, fromCache, fetchedAt } = await getMarkdownWithCache(url, ctx?.session?.token);
        const range = getLineRange(content, start_line, end_line);
        
        return JSON.stringify({
            url,
            status: 'ok',
            from_cache: fromCache,
            fetched_at: new Date(fetchedAt).toISOString(),
            start_line: range.start_line,
            end_line: range.end_line,
            total_lines: range.total_lines,
            lines_returned: range.end_line - range.start_line + 1,
            max_line_length: 250,
            content: range.content,
        }, null, 2);
    }),
});

addTool({
    name: 'grep_page_content',
    description: 'GREP TOOL: Search for regex patterns in a webpage and return matches with 25 lines of context before and after each match. Uses JavaScript regex syntax with support for flags like /pattern/gi. Perfect for finding specific content, errors, or patterns within large pages.',
    parameters: z.object({
        url: z.string().url(),
        pattern: z.string().min(1),
        max_matches: z.number().int().min(1).max(100).optional().default(20),
        case_sensitive: z.boolean().optional().default(true),
    }),
    execute: tool_fn('grep_page_content', async ({ url, pattern, max_matches, case_sensitive }, ctx) => {
        const { content, fromCache, fetchedAt } = await getMarkdownWithCache(url, ctx?.session?.token);
        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;
        
        let regex;
        try {
            // Handle regex patterns - if it looks like /pattern/flags, parse it
            const regexMatch = pattern.match(/^\/(.+)\/([gimuy]*)$/);
            if (regexMatch) {
                const [, regexPattern, flags] = regexMatch;
                regex = new RegExp(regexPattern, flags);
            } else {
                // Simple string pattern
                const flags = case_sensitive ? 'g' : 'gi';
                regex = new RegExp(pattern, flags);
            }
        } catch (error) {
            return JSON.stringify({
                url,
                status: 'error',
                error: `Invalid regex pattern: ${error.message}`,
                pattern,
            }, null, 2);
        }
        
        const matches = [];
        let matchNumber = 0;
        
        // Search through each line
        for (let i = 0; i < lines.length && matches.length < max_matches; i++) {
            const line = lines[i];
            const lineMatches = Array.from(line.matchAll(regex));
            
            for (const match of lineMatches) {
                if (matches.length >= max_matches) break;
                
                matchNumber++;
                const lineNumber = i + 1; // 1-indexed
                
                // Calculate context range (25 lines before and after)
                const contextStart = Math.max(1, lineNumber - 25);
                const contextEnd = Math.min(totalLines, lineNumber + 25);
                
                // Extract context lines
                const contextLines = [];
                for (let j = contextStart - 1; j < contextEnd; j++) { // Convert to 0-indexed
                    const contextLine = lines[j];
                    if (j === i) {
                        // Highlight the matched line
                        contextLines.push(`> ${contextLine}`);
                    } else {
                        contextLines.push(contextLine);
                    }
                }
                
                matches.push({
                    match_number: matchNumber,
                    line_number: lineNumber,
                    matched_text: match[0],
                    context_start_line: contextStart,
                    context_end_line: contextEnd,
                    context: contextLines.join('\n'),
                });
            }
        }
        
        return JSON.stringify({
            url,
            status: 'ok',
            from_cache: fromCache,
            fetched_at: new Date(fetchedAt).toISOString(),
            pattern,
            total_lines: totalLines,
            matches_found: matches.length,
            total_matches: matches.length,
            max_matches_limit: max_matches,
            results: matches,
        }, null, 2);
    }),
});

addTool({
    name: 'scrape_as_html',
    description: 'Scrape a single webpage URL with advanced options for '
    +'content extraction and get back the results in HTML. '
    +'This tool can unlock any webpage even if it uses bot detection or '
    +'CAPTCHA.',
    parameters: z.object({url: z.string().url()}),
    execute: tool_fn('scrape_as_html', async({url})=>{
        let response = await loggedAxios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: unlocker_zone,
                format: 'raw',
            },
            headers: api_headers(),
            responseType: 'text',
        }, currentRequestId);
        return response.data;
    }),
});

addTool({
    name: 'extract',
    description: 'Scrape a webpage and extract structured data as JSON. '
        + 'First scrapes the page as markdown, then uses AI sampling to convert '
        + 'it to structured JSON format. This tool can unlock any webpage even '
        + 'if it uses bot detection or CAPTCHA.',
    parameters: z.object({
        url: z.string().url(),
        extraction_prompt: z.string().optional().describe(
            'Custom prompt to guide the extraction process. If not provided, '
            + 'will extract general structured data from the page.'
        ),
    }),
    execute: tool_fn('extract', async ({ url, extraction_prompt }, ctx) => {
        let scrape_response = await loggedAxios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: unlocker_zone,
                format: 'raw',
                data_format: 'markdown',
            },
            headers: api_headers(),
            responseType: 'text',
        }, ctx?.requestId);

        let markdown_content = scrape_response.data;

        let system_prompt = 'You are a data extraction specialist. You MUST respond with ONLY valid JSON, no other text or formatting. '
            + 'Extract the requested information from the markdown content and return it as a properly formatted JSON object. '
            + 'Do not include any explanations, markdown formatting, or text outside the JSON response.';

        let user_prompt = extraction_prompt ||
            'Extract the requested information from this markdown content and return ONLY a JSON object:';

        let session = server.sessions[0]; // Get the first active session
        if (!session) throw new Error('No active session available for sampling');

        let sampling_response = await session.requestSampling({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `${user_prompt}\n\nMarkdown content:\n${markdown_content}\n\nRemember: Respond with ONLY valid JSON, no other text.`,
                    },
                },
            ],
            systemPrompt: system_prompt,
            includeContext: "thisServer",
        });

        return sampling_response.content.text;
    }),
});

addTool({
    name: 'session_stats',
    description: 'Tell the user about the tool usage during this session',
    parameters: z.object({}),
    execute: tool_fn('session_stats', async()=>{
        let used_tools = Object.entries(debug_stats.tool_calls);
        let lines = ['Tool calls this session:'];
        for (let [name, calls] of used_tools)
            lines.push(`- ${name} tool: called ${calls} times`);
        return lines.join('\n');
    }),
});

const datasets = [{
    id: 'amazon_product',
    dataset_id: 'gd_l7q7dkf244hwjntr0',
    description: [
        'Quickly read structured amazon product data.',
        'Requires a valid product URL with /dp/ in it.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'amazon_product_reviews',
    dataset_id: 'gd_le8e811kzy4ggddlq',
    description: [
        'Quickly read structured amazon product review data.',
        'Requires a valid product URL with /dp/ in it.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'amazon_product_search',
    dataset_id: 'gd_lwdb4vjm1ehb499uxs',
    description: [
        'Quickly read structured amazon product search data.',
        'Requires a valid search keyword and amazon domain URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['keyword', 'url', 'pages_to_search'],
    defaults: {pages_to_search: '1'},
}, {
    id: 'walmart_product',
    dataset_id: 'gd_l95fol7l1ru6rlo116',
    description: [
        'Quickly read structured walmart product data.',
        'Requires a valid product URL with /ip/ in it.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'walmart_seller',
    dataset_id: 'gd_m7ke48w81ocyu4hhz0',
    description: [
        'Quickly read structured walmart seller data.',
        'Requires a valid walmart seller URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'ebay_product',
    dataset_id: 'gd_ltr9mjt81n0zzdk1fb',
    description: [
        'Quickly read structured ebay product data.',
        'Requires a valid ebay product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'homedepot_products',
    dataset_id: 'gd_lmusivh019i7g97q2n',
    description: [
        'Quickly read structured homedepot product data.',
        'Requires a valid homedepot product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'zara_products',
    dataset_id: 'gd_lct4vafw1tgx27d4o0',
    description: [
        'Quickly read structured zara product data.',
        'Requires a valid zara product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'etsy_products',
    dataset_id: 'gd_ltppk0jdv1jqz25mz',
    description: [
        'Quickly read structured etsy product data.',
        'Requires a valid etsy product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'bestbuy_products',
    dataset_id: 'gd_ltre1jqe1jfr7cccf',
    description: [
        'Quickly read structured bestbuy product data.',
        'Requires a valid bestbuy product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_person_profile',
    dataset_id: 'gd_l1viktl72bvl7bjuj0',
    description: [
        'Quickly read structured linkedin people profile data.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_company_profile',
    dataset_id: 'gd_l1vikfnt1wgvvqz95w',
    description: [
        'Quickly read structured linkedin company profile data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_job_listings',
    dataset_id: 'gd_lpfll7v5hcqtkxl6l',
    description: [
        'Quickly read structured linkedin job listings data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_posts',
    dataset_id: 'gd_lyy3tktm25m4avu764',
    description: [
        'Quickly read structured linkedin posts data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_people_search',
    dataset_id: 'gd_m8d03he47z8nwb5xc',
    description: [
        'Quickly read structured linkedin people search data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'first_name', 'last_name'],
}, {
    id: 'crunchbase_company',
    dataset_id: 'gd_l1vijqt9jfj7olije',
    description: [
        'Quickly read structured crunchbase company data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'zoominfo_company_profile',
    dataset_id: 'gd_m0ci4a4ivx3j5l6nx',
    description: [
        'Quickly read structured ZoomInfo company profile data.',
        'Requires a valid ZoomInfo company URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_profiles',
    dataset_id: 'gd_l1vikfch901nx3by4',
    description: [
        'Quickly read structured Instagram profile data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_posts',
    dataset_id: 'gd_lk5ns7kz21pck8jpis',
    description: [
        'Quickly read structured Instagram post data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_reels',
    dataset_id: 'gd_lyclm20il4r5helnj',
    description: [
        'Quickly read structured Instagram reel data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_comments',
    dataset_id: 'gd_ltppn085pokosxh13',
    description: [
        'Quickly read structured Instagram comments data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'facebook_posts',
    dataset_id: 'gd_lyclm1571iy3mv57zw',
    description: [
        'Quickly read structured Facebook post data.',
        'Requires a valid Facebook post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'facebook_marketplace_listings',
    dataset_id: 'gd_lvt9iwuh6fbcwmx1a',
    description: [
        'Quickly read structured Facebook marketplace listing data.',
        'Requires a valid Facebook marketplace listing URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'facebook_company_reviews',
    dataset_id: 'gd_m0dtqpiu1mbcyc2g86',
    description: [
        'Quickly read structured Facebook company reviews data.',
        'Requires a valid Facebook company URL and number of reviews.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'num_of_reviews'],
}, {
    id: 'facebook_events',
    dataset_id: 'gd_m14sd0to1jz48ppm51',
    description: [
        'Quickly read structured Facebook events data.',
        'Requires a valid Facebook event URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_profiles',
    dataset_id: 'gd_l1villgoiiidt09ci',
    description: [
        'Quickly read structured Tiktok profiles data.',
        'Requires a valid Tiktok profile URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_posts',
    dataset_id: 'gd_lu702nij2f790tmv9h',
    description: [
        'Quickly read structured Tiktok post data.',
        'Requires a valid Tiktok post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_shop',
    dataset_id: 'gd_m45m1u911dsa4274pi',
    description: [
        'Quickly read structured Tiktok shop data.',
        'Requires a valid Tiktok shop product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_comments',
    dataset_id: 'gd_lkf2st302ap89utw5k',
    description: [
        'Quickly read structured Tiktok comments data.',
        'Requires a valid Tiktok video URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'google_maps_reviews',
    dataset_id: 'gd_luzfs1dn2oa0teb81',
    description: [
        'Quickly read structured Google maps reviews data.',
        'Requires a valid Google maps URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'days_limit'],
    defaults: {days_limit: '3'},
}, {
    id: 'google_shopping',
    dataset_id: 'gd_ltppk50q18kdw67omz',
    description: [
        'Quickly read structured Google shopping data.',
        'Requires a valid Google shopping product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'google_play_store',
    dataset_id: 'gd_lsk382l8xei8vzm4u',
    description: [
        'Quickly read structured Google play store data.',
        'Requires a valid Google play store app URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'apple_app_store',
    dataset_id: 'gd_lsk9ki3u2iishmwrui',
    description: [
        'Quickly read structured apple app store data.',
        'Requires a valid apple app store app URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'reuter_news',
    dataset_id: 'gd_lyptx9h74wtlvpnfu',
    description: [
        'Quickly read structured reuter news data.',
        'Requires a valid reuter news report URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'github_repository_file',
    dataset_id: 'gd_lyrexgxc24b3d4imjt',
    description: [
        'Quickly read structured github repository data.',
        'Requires a valid github repository file URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'yahoo_finance_business',
    dataset_id: 'gd_lmrpz3vxmz972ghd7',
    description: [
        'Quickly read structured yahoo finance business data.',
        'Requires a valid yahoo finance business URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'x_posts',
    dataset_id: 'gd_lwxkxvnf1cynvib9co',
    description: [
        'Quickly read structured X post data.',
        'Requires a valid X post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'zillow_properties_listing',
    dataset_id: 'gd_lfqkr8wm13ixtbd8f5',
    description: [
        'Quickly read structured zillow properties listing data.',
        'Requires a valid zillow properties listing URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'booking_hotel_listings',
    dataset_id: 'gd_m5mbdl081229ln6t4a',
    description: [
        'Quickly read structured booking hotel listings data.',
        'Requires a valid booking hotel listing URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'youtube_profiles',
    dataset_id: 'gd_lk538t2k2p1k3oos71',
    description: [
        'Quickly read structured youtube profiles data.',
        'Requires a valid youtube profile URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'youtube_comments',
    dataset_id: 'gd_lk9q0ew71spt1mxywf',
    description: [
        'Quickly read structured youtube comments data.',
        'Requires a valid youtube video URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'num_of_comments'],
    defaults: {num_of_comments: '10'},
}, {
    id: 'reddit_posts',
    dataset_id: 'gd_lvz8ah06191smkebj4',
    description: [
        'Quickly read structured reddit posts data.',
        'Requires a valid reddit post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'youtube_videos',
    dataset_id: 'gd_lk56epmy2i5g7lzu0k',
    description: [
        'Quickly read structured YouTube videos data.',
        'Requires a valid YouTube video URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}];
for (let {dataset_id, id, description, inputs, defaults = {}} of datasets)
{
    let parameters = {};
    for (let input of inputs)
    {
        let param_schema = input=='url' ? z.string().url() : z.string();
        parameters[input] = defaults[input] !== undefined ?
            param_schema.default(defaults[input]) : param_schema;
    }
    addTool({
        name: `web_data_${id}`,
        description,
        parameters: z.object(parameters),
        execute: tool_fn(`web_data_${id}`, async(data, ctx)=>{
            let trigger_response = await loggedAxios({
                url: 'https://api.brightdata.com/datasets/v3/trigger',
                params: {dataset_id, include_errors: true},
                method: 'POST',
                data: [data],
                headers: api_headers(),
            }, ctx?.requestId);
            if (!trigger_response.data?.snapshot_id)
                throw new Error('No snapshot ID returned from request');
            let snapshot_id = trigger_response.data.snapshot_id;
            console.error(`[web_data_${id}] triggered collection with `
                +`snapshot ID: ${snapshot_id}`);
            let max_attempts = 600;
            let attempts = 0;
            while (attempts < max_attempts)
            {
                try {
                    if (ctx && ctx.reportProgress)
                    {
                        await ctx.reportProgress({
                            progress: attempts,
                            total: max_attempts,
                            message: `Polling for data (attempt `
                                +`${attempts + 1}/${max_attempts})`,
                        });
                    }
                    let snapshot_response = await loggedAxios({
                        url: `https://api.brightdata.com/datasets/v3`
                            +`/snapshot/${snapshot_id}`,
                        params: {format: 'json'},
                        method: 'GET',
                        headers: api_headers(),
                    }, ctx?.requestId);
                    if (['running', 'building'].includes(snapshot_response.data?.status))
                    {
                        console.error(`[web_data_${id}] snapshot not ready, `
                            +`polling again (attempt `
                            +`${attempts + 1}/${max_attempts})`);
                        attempts++;
                        await new Promise(resolve=>setTimeout(resolve, 1000));
                        continue;
                    }
                    console.error(`[web_data_${id}] snapshot data received `
                        +`after ${attempts + 1} attempts`);
                    let result_data = JSON.stringify(snapshot_response.data);
                    return result_data;
                } catch(e){
                    console.error(`[web_data_${id}] polling error: `
                        +`${e.message}`);
                    attempts++;
                    await new Promise(resolve=>setTimeout(resolve, 1000));
                }
            }
            throw new Error(`Timeout after ${max_attempts} seconds waiting `
                +`for data`);
        }),
    });
}

for (let tool of browser_tools)
    addTool(tool);

// Add HTTP response logging by intercepting the server creation
if (debug_log_file && transport_type === 'http') {
    const originalCreateServer = http.createServer;
    
    http.createServer = function(requestListener) {
        const wrappedListener = (req, res) => {
            // Generate UUID immediately when request arrives at HTTP level
            const httpRequestId = crypto.randomUUID();
            req._httpRequestId = httpRequestId;
            
            // Log incoming HTTP request immediately at HTTP level
            debugLog('INCOMING_HTTP_REQUEST', {
                method: req.method,
                url: req.url,
                headers: req.headers,
                timestamp: new Date().toISOString()
            }, httpRequestId);
            
            const originalWrite = res.write;
            const originalEnd = res.end;
            let responseBody = '';
            
            res.write = function(chunk, encoding) {
                if (chunk) responseBody += chunk.toString();
                return originalWrite.call(this, chunk, encoding);
            };
            
            res.end = function(data) {
                if (data) responseBody += data.toString();
                
                // Use the same UUID that was generated for the incoming request
                const requestId = req._httpRequestId;
                
                // Log the complete outgoing HTTP response
                debugLog('OUTGOING_HTTP_RESPONSE', {
                    statusCode: this.statusCode,
                    statusMessage: this.statusMessage,
                    headers: this.getHeaders(),
                    body: responseBody,
                    bodySize: responseBody.length,
                    timestamp: new Date().toISOString()
                }, requestId);
                
                return originalEnd.call(this, data);
            };
            
            return requestListener(req, res);
        };
        
        return originalCreateServer.call(this, wrappedListener);
    };
}

console.error('Starting server...');
if (transport_type === 'http') {
    console.error(`Starting HTTP server on port ${http_port}...`);
    
    // For HTTP mode, require either env token or auth header
    if (!api_token) {
        console.error('Note: No API_TOKEN in environment. Token must be provided via Authorization: Bearer header');
    }
    
    server.start({
        transportType: 'httpStream',
        httpStream: {
            port: http_port,
            host: '0.0.0.0',  // Bind to all network interfaces
            stateless: true  // Enable stateless mode for simpler HTTP API usage
        }
    });
    console.error(`✅ MCP server running at http://0.0.0.0:${http_port}/mcp`);
    console.error(`Usage: Send requests with Authorization: Bearer YOUR_API_TOKEN header`);
    console.error(`Pro mode: Add ?pro_mode=true to URL`);
} else {
    server.start({transportType: 'stdio'});
}
function tool_fn(name, fn){
    return async(data, ctx)=>{
        const requestId = ctx?.session?.requestId || null;
        const previousRequestId = currentRequestId;
        currentRequestId = requestId; // Set current request context
        
        // In HTTP mode, check that we have a valid token for tool calls
        if (transport_type === 'http' && !ctx?.session?.authenticated) {
            throw new Error('Authentication required: tool calls need Authorization: Bearer token');
        }
        
        // Debug log the MCP tool request
        debugLog(`MCP_TOOL_REQUEST_${name}`, {
            tool: name,
            data: data,
            session: ctx?.session ? { authenticated: ctx.session.authenticated } : null,
            timestamp: new Date().toISOString()
        }, requestId);
        
        check_rate_limit();
        debug_stats.tool_calls[name] = debug_stats.tool_calls[name]||0;
        debug_stats.tool_calls[name]++;
        debug_stats.session_calls++;
        let ts = Date.now();
        console.error(`[%s] executing %s`, name, JSON.stringify(data));
        try { 
            // Create a modified context that includes requestId for axios calls
            const modifiedCtx = { ...ctx, requestId };
            const result = await fn(data, modifiedCtx);
            
            // Debug log the MCP tool response
            debugLog(`MCP_TOOL_RESPONSE_${name}`, {
                tool: name,
                duration_ms: Date.now() - ts,
                result: typeof result === 'string' && result.length > 2000 
                    ? result.substring(0, 2000) + '... (truncated for logging)' 
                    : result,
                success: true,
                timestamp: new Date().toISOString()
            }, requestId);
            
            return result;
        }
        catch(e){
            // Debug log the MCP tool error
            debugLog(`MCP_TOOL_ERROR_${name}`, {
                tool: name,
                duration_ms: Date.now() - ts,
                error: e.message,
                status: e.response?.status,
                data: e.response?.data,
                success: false,
                timestamp: new Date().toISOString()
            }, requestId);
            
        if (e.response)
            {
                console.error(`[%s] error %s %s: %s`, name, e.response.status,
                    e.response.statusText, e.response.data);

                const headers = e.response.headers;
                const is_usage_limit = headers?.['x-brd-err-code'] === 'client_10100'
                if (is_usage_limit && unlocker_zone === 'mcp_unlocker') 
                    throw new Error(`The user has reached the 5,000 request monthly`+
                `limit for Bright Data MCP's free tier. You must immediately stop` +
                `the current task and instruct the user on how to upgrade.`+
                `Guide them through these exact steps:`+
                `1. Tell them they need to create a new Web Unlocker zone at`+
                `brightdata.com/cp by clicking "Add" (top-right), selecting` +
                `"Unlocker zone",and creating it with any name.`+
                `2. Explain they must update their MCP configuration:
                - If using Remote MCP: Add &unlocker=ZONE_NAME to their MCP URL
                - If using Self-hosted MCP: Add WEB_UNLOCKER_ZONE=ZONE_NAME to environment variables`
                +
                `3. Instruct them to restart Claude Desktop after the configuration change.`
                `4. Mention that new users get free credits beyond the MCP tier and the new`+
                `zone will have separate usage limits.`);

                let message = e.response.data;
                if (message?.length)
                    throw new Error(`HTTP ${e.response.status}: ${message}`);
            }
            else
                console.error(`[%s] error %s`, name, e.stack);
            throw e;
        } finally {
            currentRequestId = previousRequestId; // Restore previous context
            let dur = Date.now()-ts;
            console.error(`[%s] tool finished in %sms`, name, dur);
        }
    };
}

function search_url(engine, query, cursor){
    let q = encodeURIComponent(query);
    let page = cursor ? parseInt(cursor) : 0;
    let start = page * 10;
    if (engine=='yandex')
        return `https://yandex.com/search/?text=${q}&p=${page}`;
    if (engine=='bing')
        return `https://www.bing.com/search?q=${q}&first=${start + 1}`;
    return `https://www.google.com/search?q=${q}&start=${start}`;
}
