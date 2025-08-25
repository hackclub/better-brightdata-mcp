#!/usr/bin/env node
'use strict'; /*jslint node:true es9:true*/
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import axios from 'axios';
import {tools as browser_tools} from './browser_tools.js';
import {createRequire} from 'node:module';
import {appendFileSync} from 'fs';
const require = createRequire(import.meta.url);
const package_json = require('./package.json');
let api_token = process.env.API_TOKEN;
const unlocker_zone = process.env.WEB_UNLOCKER_ZONE || 'mcp_unlocker';
const browser_zone = process.env.BROWSER_ZONE || 'mcp_browser';
const pro_mode = process.env.PRO_MODE === 'true';
const http_port = parseInt(process.env.HTTP_PORT || '3000', 10);
const transport_type = process.env.TRANSPORT_TYPE || 'stdio'; // 'stdio' or 'http'
const debug_log_to_file = process.env.DEBUG_LOG_TO_FILE === 'true';
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
        let response = await axios({
            url: 'https://api.brightdata.com/zone/get_active_zones',
            method: 'GET',
            headers: api_headers(),
        });
        let zones = response.data || [];
        let has_unlocker_zone = zones.some(zone=>zone.name==unlocker_zone);
        let has_browser_zone = zones.some(zone=>zone.name==browser_zone);
        
        if (!has_unlocker_zone)
        {
            console.error(`Required zone "${unlocker_zone}" not found, `
                +`creating it...`);
            await axios({
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
            });
            console.error(`Zone "${unlocker_zone}" created successfully`);
        }
        else
            console.error(`Required zone "${unlocker_zone}" already exists`);
            
        if (!has_browser_zone)
        {
            console.error(`Required zone "${browser_zone}" not found, `
                +`creating it...`);
            await axios({
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
            });
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
        // Always allow requests through, but capture auth info
        const authHeader = request.headers.authorization;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            api_token = token; // Update global token
            return {
                token: token,
                headers: request.headers,
                authenticated: true,
            };
        }
        
        // No auth provided - allow initialize but mark as unauthenticated
        return {
            token: null,
            headers: request.headers,
            authenticated: false,
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

async function fetchMarkdownRaw(url) {
    let response = await axios({
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
    });
    return response.data;
}

async function getMarkdownWithCache(url, { force = false } = {}) {
    const now = Date.now();
    const cached = pageCache.get(url);
    
    // Immediately remove expired entries to prevent memory leaks
    if (cached && (now - cached.fetchedAt) >= PAGE_CACHE_TTL_MS) {
        console.error(`[Cache EXPIRED] Removing ${url} (age: ${Math.round((now - cached.fetchedAt) / 1000)}s)`);
        pageCache.delete(url);
        // Treat as if no cache entry exists
        cached = null;
    }
    
    if (!force && cached) {
        const ageSeconds = Math.round((now - cached.fetchedAt) / 1000);
        console.error(`[Cache HIT] ${url} (age: ${ageSeconds}s, size: ${pageCache.size})`);
        return { content: cached.content, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    
    console.error(`[Cache MISS] Fetching ${url}${force ? ' (forced)' : ''}`);
    const rawContent = await fetchMarkdownRaw(url);
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

function previewText(content, preview_lines) {
    const MAX_PREVIEW_CHARS = 100000; // 100KB character limit for previews
    
    // Strip out image links first to reduce content size
    const strippedContent = stripImageLinks(content);
    const lines = strippedContent.split(/\r?\n/);
    
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

function debugLog(type, data) {
    if (!debug_log_to_file) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${type}: ${JSON.stringify(data, null, 2)}\n\n`;
    
    try {
        appendFileSync('debug_log', logEntry);
    } catch (e) {
        console.error('Failed to write debug log:', e.message);
    }
}

const addTool = (tool) => {
    if (!pro_mode && !pro_mode_tools.includes(tool.name)) 
        return;
    server.addTool(tool);
};

addTool({
    name: 'search_engine',
    description: 'Scrape search results from Google, Bing or Yandex. Returns '
    +'SERP results in markdown (URL, title, description)',
    parameters: z.object({
        query: z.string(),
        engine: z.enum([
            'google',
            'bing',
            'yandex',
        ]).optional().default('google'),
        cursor: z.string().optional().describe('Pagination cursor for next page'),
    }),
    execute: tool_fn('search_engine', async({query, engine, cursor})=>{
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url: search_url(engine, query, cursor),
                zone: unlocker_zone,
                format: 'raw',
                data_format: 'markdown',
            },
            headers: api_headers(),
            responseType: 'text',
        });

        return response.data;
    }),
});


addTool({
    name: 'get_page_previews',
    description: 'PRIMARY TOOL: Fetch multiple URLs (max 10) in parallel and return markdown previews (first 500 lines). When analyzing multiple search results or related pages, batch them together for efficiency. Use heavily - fast, cached (10-minute TTL), designed for frequent use. All lines are max 250 chars each. Use get_page_content_range to get specific line ranges beyond the preview.',
    parameters: z.object({
        urls: z.array(z.string().url()).min(1).max(10),
        force: z.boolean().optional().default(false),
    }),
    execute: tool_fn('get_page_previews', async ({ urls, force }) => {
        const nowISO = new Date().toISOString();
        const results = await Promise.all(urls.map(async (url) => {
            try {
                const { content, fromCache, fetchedAt } = await getMarkdownWithCache(url, { force });
                const p = previewText(content, 500); // Always 500 lines
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
                return {
                    url,
                    status: 'error',
                    error: e.response?.data || e.message || String(e),
                };
            }
        }));
        return JSON.stringify({
            tool: 'get_page_previews',
            now: nowISO,
            ttl_ms: PAGE_CACHE_TTL_MS,
            max_line_length: 250,
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
        force: z.boolean().optional().default(false),
    }).refine(data => data.end_line >= data.start_line, {
        message: "end_line must be >= start_line"
    }).refine(data => (data.end_line - data.start_line + 1) <= 5000, {
        message: "Cannot request more than 5000 lines at once"
    }),
    execute: tool_fn('get_page_content_range', async ({ url, start_line, end_line, force }) => {
        const { content, fromCache, fetchedAt } = await getMarkdownWithCache(url, { force });
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
        force: z.boolean().optional().default(false),
    }),
    execute: tool_fn('grep_page_content', async ({ url, pattern, max_matches, case_sensitive, force }) => {
        const { content, fromCache, fetchedAt } = await getMarkdownWithCache(url, { force });
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
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: unlocker_zone,
                format: 'raw',
            },
            headers: api_headers(),
            responseType: 'text',
        });
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
        let scrape_response = await axios({
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
        });

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
            let trigger_response = await axios({
                url: 'https://api.brightdata.com/datasets/v3/trigger',
                params: {dataset_id, include_errors: true},
                method: 'POST',
                data: [data],
                headers: api_headers(),
            });
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
                    let snapshot_response = await axios({
                        url: `https://api.brightdata.com/datasets/v3`
                            +`/snapshot/${snapshot_id}`,
                        params: {format: 'json'},
                        method: 'GET',
                        headers: api_headers(),
                    });
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
            stateless: true  // Enable stateless mode for simpler HTTP API usage
        }
    });
    console.error(`✅ MCP server running at http://localhost:${http_port}/mcp`);
    console.error(`Usage: Send requests with Authorization: Bearer YOUR_API_TOKEN header`);
    console.error(`Pro mode: Add ?pro_mode=true to URL`);
} else {
    server.start({transportType: 'stdio'});
}
function tool_fn(name, fn){
    return async(data, ctx)=>{
        // In HTTP mode, check that we have a valid token for tool calls
        if (transport_type === 'http' && !ctx?.session?.authenticated) {
            throw new Error('Authentication required: tool calls need Authorization: Bearer token');
        }
        
        // Debug log the request
        debugLog(`REQUEST_${name}`, {
            tool: name,
            data: data,
            session: ctx?.session ? { authenticated: ctx.session.authenticated } : null,
        });
        
        check_rate_limit();
        debug_stats.tool_calls[name] = debug_stats.tool_calls[name]||0;
        debug_stats.tool_calls[name]++;
        debug_stats.session_calls++;
        let ts = Date.now();
        console.error(`[%s] executing %s`, name, JSON.stringify(data));
        try { 
            const result = await fn(data, ctx);
            
            // Debug log the response
            debugLog(`RESPONSE_${name}`, {
                tool: name,
                duration_ms: Date.now() - ts,
                result: result,
            });
            
            return result;
        }
        catch(e){
            // Debug log the error
            debugLog(`ERROR_${name}`, {
                tool: name,
                duration_ms: Date.now() - ts,
                error: e.message,
                status: e.response?.status,
                data: e.response?.data,
            });
            
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
