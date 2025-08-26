# Available Tools

**Default Mode (FREE)**: Web scraping and structured data extraction tools are available by default.  
**Pro Mode**: Set `PRO_MODE=true` to access ALL tools including browser automation (additional charges may apply).

|Feature|Description|Available By Default|
|---|---|---|
|search_engine|**PRIMARY SEARCH TOOL**: Execute multiple search queries (max 5) **in parallel** across Google, Bing, or Yandex. **Batch multiple searches together** for efficiency. Returns SERP results in markdown for each query. Params: `queries[]` with `query`, `engine?=google`, `cursor?` fields.|✅ YES|
|get_page_previews|**PRIMARY TOOL**: Fetch multiple URLs (up to 10) **in parallel** and return markdown previews (first 500 lines). **Batch multiple search results together** for efficiency. Use heavily - fast, cached (10-minute TTL), max 250 chars per line. Includes guidance for using get_page_content_range. Params: `urls[]`, `force?=false`.|✅ YES|
|get_page_content_range|**RANGE TOOL**: Fetch specific line range from single URL (e.g., lines 501-1000). Max 5000 lines per request, max 250 chars per line. Use after previews for more content. Params: `url`, `start_line`, `end_line`, `force?=false`.|✅ YES|
|grep_page_content|**GREP TOOL**: Search for regex patterns in webpage content and return matches with 25 lines of context before/after each match. Supports JavaScript regex syntax with flags like /pattern/gi. Perfect for finding specific content, errors, or patterns. Params: `url`, `pattern`, `max_matches?=20`, `case_sensitive?=true`, `force?=false`.|✅ YES|
|web_data_reddit_posts|Quickly read structured reddit posts data. Requires a valid reddit post URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_youtube_comments|Quickly read structured youtube comments data. Requires a valid youtube video URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_youtube_profiles|Quickly read structured youtube profiles data. Requires a valid youtube profile URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_apple_app_store|Quickly read structured apple app store data. Requires a valid apple app store app URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_google_play_store|Quickly read structured Google play store data. Requires a valid Google play store app URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_tiktok_posts|Quickly read structured Tiktok post data. Requires a valid Tiktok post URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_tiktok_profiles|Quickly read structured Tiktok profiles data. Requires a valid Tiktok profile URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_youtube_videos|Quickly read structured YouTube videos data. Requires a valid YouTube video URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_x_posts|Quickly read structured X post data. Requires a valid X post URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_instagram_posts|Quickly read structured Instagram post data. Requires a valid Instagram URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_instagram_reels|Quickly read structured Instagram reel data. Requires a valid Instagram URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_instagram_comments|Quickly read structured Instagram comments data. Requires a valid Instagram URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|web_data_instagram_profiles|Quickly read structured Instagram profile data. Requires a valid Instagram URL. This can be a cache lookup, so it can be more reliable than scraping|✅ YES|
|scrape_as_html|Scrape a single webpage URL with advanced options for content extraction and get back the results in HTML. This tool can unlock any webpage even if it uses bot detection or CAPTCHA.|🔒 Pro Only|
|session_stats|Tell the user about the tool usage during this session|🔒 Pro Only|
|web_data_amazon_product|Quickly read structured amazon product data. Requires a valid product URL with /dp/ in it. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_amazon_product_reviews|Quickly read structured amazon product review data. Requires a valid product URL with /dp/ in it. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_linkedin_person_profile|Quickly read structured linkedin people profile data. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_linkedin_company_profile|Quickly read structured linkedin company profile data. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_zoominfo_company_profile|Quickly read structured ZoomInfo company profile data. Requires a valid ZoomInfo company URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_facebook_posts|Quickly read structured Facebook post data. Requires a valid Facebook post URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_facebook_marketplace_listings|Quickly read structured Facebook marketplace listing data. Requires a valid Facebook marketplace listing URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_facebook_company_reviews|Quickly read structured Facebook company reviews data. Requires a valid Facebook company URL and number of reviews. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_zillow_properties_listing|Quickly read structured zillow properties listing data. Requires a valid zillow properties listing URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_booking_hotel_listings|Quickly read structured booking hotel listings data. Requires a valid booking hotel listing URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|scraping_browser_navigate|Navigate a scraping browser session to a new URL|🔒 Pro Only|
|scraping_browser_go_back|Go back to the previous page|🔒 Pro Only|
|scraping_browser_go_forward|Go forward to the next page|🔒 Pro Only|
|scraping_browser_click|Click on an element. Avoid calling this unless you know the element selector (you can use other tools to find those)|🔒 Pro Only|
|scraping_browser_links|Get all links on the current page, text and selectors. It's strongly recommended that you call the links tool to check that your click target is valid|🔒 Pro Only|
|scraping_browser_type|Type text into an element|🔒 Pro Only|
|scraping_browser_wait_for|Wait for an element to be visible on the page|🔒 Pro Only|
|scraping_browser_screenshot|Take a screenshot of the current page|🔒 Pro Only|
|scraping_browser_get_html|Get the HTML content of the current page. Avoid using the full_page option unless it is important to see things like script tags since this can be large|🔒 Pro Only|
|scraping_browser_get_text|Get the text content of the current page|🔒 Pro Only|
|web_data_amazon_product_search|Quickly read structured amazon product search data. Requires a valid search keyword and amazon domain URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_walmart_product|Quickly read structured walmart product data. Requires a valid product URL with /ip/ in it. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_walmart_seller|Quickly read structured walmart seller data. Requires a valid walmart seller URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_ebay_product|Quickly read structured ebay product data. Requires a valid ebay product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_homedepot_products|Quickly read structured homedepot product data. Requires a valid homedepot product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_zara_products|Quickly read structured zara product data. Requires a valid zara product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_etsy_products|Quickly read structured etsy product data. Requires a valid etsy product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_bestbuy_products|Quickly read structured bestbuy product data. Requires a valid bestbuy product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_linkedin_job_listings|Quickly read structured linkedin job listings data. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_linkedin_posts|Quickly read structured linkedin posts data. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_linkedin_people_search|Quickly read structured linkedin people search data. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_crunchbase_company|Quickly read structured crunchbase company data. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_facebook_events|Quickly read structured Facebook events data. Requires a valid Facebook event URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_tiktok_shop|Quickly read structured Tiktok shop data. Requires a valid Tiktok shop product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_tiktok_comments|Quickly read structured Tiktok comments data. Requires a valid Tiktok video URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_google_maps_reviews|Quickly read structured Google maps reviews data. Requires a valid Google maps URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_google_shopping|Quickly read structured Google shopping data. Requires a valid Google shopping product URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_reuter_news|Quickly read structured reuter news data. Requires a valid reuter news report URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_github_repository_file|Quickly read structured github repository data. Requires a valid github repository file URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
|web_data_yahoo_finance_business|Quickly read structured yahoo finance business data. Requires a valid yahoo finance business URL. This can be a cache lookup, so it can be more reliable than scraping|🔒 Pro Only|
