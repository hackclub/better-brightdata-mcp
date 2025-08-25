# Changelog

All notable changes to this project will be documented in this file.

## [2.6.0] - 2025-08-25

### Added
- **Social media and app store data extraction tools** now available in default (non-pro) mode:
  - `web_data_reddit_posts`, `web_data_youtube_comments`, `web_data_youtube_profiles`, `web_data_youtube_videos`
  - `web_data_apple_app_store`, `web_data_google_play_store` 
  - `web_data_tiktok_posts`, `web_data_tiktok_profiles`
  - `web_data_x_posts`, `web_data_instagram_posts`, `web_data_instagram_reels`, `web_data_instagram_comments`, `web_data_instagram_profiles`
- Updated Tools.md with clear "Available By Default" column showing which tools are free vs pro-only

## [2.5.0] - 2025-08-25

### Added
- New `get_page_previews` tool: fetch up to 10 URLs in parallel and return previews (lines 1-N, default 500)
- New `get_page_content_range` tool: fetch specific line ranges from single URL (max 5000 lines per request)
- 10-minute in-memory cache for page contents (`PAGE_CACHE_TTL_MS`)
- HTTP transport mode for easier integration (`TRANSPORT_TYPE=http`)
- Support for Authorization: Bearer token authentication in HTTP mode
- Debug logging to file with timestamps (`DEBUG_LOG_TO_FILE=true`)
- Automatic line length processing: lines > 5000 chars are split into multiple lines
- Image stripping functionality to remove all markdown image links and reduce token usage

### Changed
- Default toolset now exposes `get_page_previews` and `get_page_content_range` instead of `scrape_as_markdown`
- All cached content has max 250 characters per line for better context window management
- Dockerfile optimized for containerized deployment with HTTP mode as default

### Removed
- `scrape_as_markdown` tool (replaced by new caching tools)
- All markdown image links are now stripped from content to reduce token usage

## [2.0.0] - 2025-05-26

### Changed
- Updated browser authentication to use API_TOKEN instead of previous authentication method
- BROWSER_ZONE is now an optional parameter, the deafult zone is `mcp_browser`
- Removed duplicate web_data_ tools

## [1.9.2] - 2025-05-23

### Fixed
- Fixed GitHub references and repository settings

## [1.9.1] - 2025-05-21

### Fixed
- Fixed spelling errors and improved coding conventions
- Converted files back to Unix line endings for consistency

## [1.9.0] - 2025-05-21

### Added
- Added 23 new web data tools for enhanced data collection capabilities
- Added progress reporting functionality for better user feedback
- Added default parameter handling for improved tool usability

### Changed
- Improved coding conventions and file formatting
- Enhanced web data API endpoints integration

## [1.8.3] - 2025-05-21

### Added
- Added Bright Data MCP with Claude demo video to README.md

### Changed
- Updated documentation with video demonstrations

## [1.8.2] - 2025-05-13

### Changed
- Bumped FastMCP version for improved performance
- Updated README.md with additional documentation

## [1.8.1] - 2025-05-05

### Added
- Added 12 new WSAPI endpoints for enhanced functionality
- Changed to polling mechanism for better reliability

### Changed
- Applied dos2unix formatting for consistency
- Updated Docker configuration
- Updated smithery.yaml configuration

## [1.8.0] - 2025-05-03

### Added
- Added domain-based browser sessions to avoid navigation limit issues
- Added automatic creation of required unlocker zone when not present

### Fixed
- Fixed browser context maintenance across tool calls with current domain tracking
- Minor lint fixes

## [1.0.0] - 2025-04-29

### Added
- Initial release of Bright Data MCP server
- Browser automation capabilities with Bright Data integration
- Core web scraping and data collection tools
- Smithery.yaml configuration for deployment in Smithery.ai
- MIT License
- Demo materials and documentation

### Documentation
- Created comprehensive README.md
- Added demo.md with usage examples
- Created examples/README.md for sample implementations
- Added Tools.md documentation for available tools

---

## Release Notes

### Version 1.9.x Series
The 1.9.x series focuses on expanding web data collection capabilities and improving authentication mechanisms. Key highlights include the addition of 23 new web data tools.

### Version 1.8.x Series  
The 1.8.x series introduced significant improvements to browser session management, WSAPI endpoints, and overall system reliability. Notable features include domain-based sessions and automatic zone creation.

### Version 1.0.0
Initial stable release providing core MCP server functionality for Bright Data integration with comprehensive browser automation and web scraping capabilities.

