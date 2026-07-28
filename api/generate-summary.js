export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Get search query and page from request
  let searchQuery = (req.method === 'GET' ? req.query.query : req.body?.query) || '';
  let page = parseInt(req.method === 'GET' ? req.query.page : req.body?.page) || 1;
  
  // Limit page to prevent excessive requests
  if (page < 1) page = 1;
  if (page > 10) page = 10;

  const itemsPerPage = 4;
  const startIndex = (page - 1) * itemsPerPage;

  // Configurable cooldown (ms). 기본 1초로 설정
  const COOLDOWN_MS = Number(process.env.GENERATE_SUMMARY_COOLDOWN_MS) || 1_000;

  // Helper: fetch with retry and respect Retry-After header
  async function fetchWithRetry(url, opts, maxAttempts = 3) {
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      let resp;
      try {
        resp = await fetch(url, opts);
      } catch (e) {
        console.warn('fetch error', e);
        if (attempt >= maxAttempts) return { ok: false, status: 'network_error', bodyText: String(e), headers: new Map() };
        await new Promise(r => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
        continue;
      }
      const headers = resp.headers;
      const bodyText = await resp.text().catch(() => null);
      const retryAfterHeader = headers.get ? headers.get('retry-after') : null;
      console.info(`Google News RSS attempt=${attempt} status=${resp.status} retry-after=${retryAfterHeader}`);

      if (resp.ok) {
        return { ok: true, rawBodyText: bodyText, headers };
      }

      // 429: respect retry-after or use exponential backoff
      if (resp.status === 429) {
        global._generateSummaryLastRequestAt = Date.now();
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Math.min(1000 * 2 ** attempt, 5000);
        console.warn('Google News 429 body:', bodyText);
        if (attempt >= maxAttempts) {
          return { ok: false, status: resp.status, bodyText, headers };
        }
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // Retry on 5xx
      if (resp.status >= 500 && attempt < maxAttempts) {
        const waitMs = Math.min(500 * 2 ** attempt, 5000);
        console.warn(`Server error ${resp.status}, retrying after ${waitMs}ms`, bodyText);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // non-retriable or out of attempts
      return { ok: false, status: resp.status, bodyText, headers };
    }
    return { ok: false, status: 'max_attempts' };
  }

  // Helper: Parse RSS XML to JSON
  function parseRssToJson(rssXml, limit = 100) {
    try {
      // Extract items from RSS feed
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      const items = [];
      let match;
      let id = 1;

      while ((match = itemRegex.exec(rssXml)) !== null && id <= limit) {
        const itemContent = match[1];
        
        // Extract title
        const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : '';
        
        // Extract description
        const descMatch = itemContent.match(/<description>([\s\S]*?)<\/description>/);
        const summary = descMatch ? descMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : '';
        
        // Extract link
        const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/);
        const link = linkMatch ? linkMatch[1].trim() : '';
        
        // Extract pubDate
        const pubDateMatch = itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const pubDate = pubDateMatch ? pubDateMatch[1].trim() : '';

        if (title && link) {
          items.push({
            id: id,
            title: title,
            summary: summary,
            link: link,
            pubDate: pubDate
          });
          id++;
        }
      }

      return items;
    } catch (error) {
      console.error('RSS parsing error:', error);
      return [];
    }
  }

  // Initialize globals for best-effort concurrency control in serverless env
  if (!global._generateSummaryLastRequestAt) global._generateSummaryLastRequestAt = 0;
  if (typeof global._generateSummaryInFlight === 'undefined') global._generateSummaryInFlight = false;

  const now = Date.now();

  try {
    // mark in-flight to prevent concurrent API calls in this instance
    global._generateSummaryInFlight = true;

    // Google News RSS API 요청
    let googleNewsUrl;
    if (searchQuery) {
      googleNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&when:24h&hl=ko&gl=KR&ceid=KR:ko`;
    } else {
      googleNewsUrl = `https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko`;
    }

    const apiResponse = await fetchWithRetry(
      googleNewsUrl,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    );

    if (!apiResponse.ok) {
      // propagate retry-after header if present
      const headers = apiResponse.headers || {};
      const retryAfterHeader = headers.get ? headers.get('retry-after') : null;
      if (retryAfterHeader) res.setHeader('Retry-After', retryAfterHeader);

      // record last request time so subsequent callers hit cooldown
      global._generateSummaryLastRequestAt = Date.now();

      const status = apiResponse.status || 429;
      return res.status(status).json({ error: `Google News API error (${status}): ${apiResponse.bodyText || apiResponse.rawBodyText}` });
    }

    // Parse RSS feed - fetch more items for pagination
    const rssXml = apiResponse.rawBodyText;
    
    if (!rssXml) {
      global._generateSummaryLastRequestAt = Date.now();
      return res.status(500).json({
        error: 'Google News API로부터 응답을 받지 못했습니다.'
      });
    }

    const allNewsItems = parseRssToJson(rssXml, 100); // Parse up to 100 items

    if (allNewsItems.length === 0) {
      global._generateSummaryLastRequestAt = Date.now();
      return res.status(500).json({
        error: 'Google News API로부터 뉴스 항목을 받지 못했습니다.'
      });
    }

    // Pagination logic
    const paginatedItems = allNewsItems.slice(startIndex, startIndex + itemsPerPage);
    const hasMore = startIndex + itemsPerPage < allNewsItems.length;

    // Re-index items for this page
    const newsItems = paginatedItems.map((item, index) => ({
      ...item,
      id: startIndex + index + 1
    }));

    // successful response: record last success time (enable cooldown)
    global._generateSummaryLastRequestAt = Date.now();

    return res.status(200).json({
      items: newsItems,
      page: page,
      hasMore: hasMore,
      total: allNewsItems.length
    });
  } catch (error) {
    console.error('Serverless Function Error:', error);

    // on unexpected error, record last request time to reduce rapid retries
    global._generateSummaryLastRequestAt = Date.now();

    return res.status(502).json({
      error: error?.message || '서버 내부 오류가 발생했습니다.'
    });
  } finally {
    // always clear in-flight flag so next requests can proceed
    global._generateSummaryInFlight = false;
  }
}
