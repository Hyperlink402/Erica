export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Accept multiple possible param names to be forgiving about typos from clients
  const getFromQuery = (name) => (req.query && typeof req.query === 'object') ? req.query[name] : undefined;
  const getFromBody = (name) => (req.body && typeof req.body === 'object') ? req.body[name] : undefined;

  const topic = (req.method === 'GET'
    ? (getFromQuery('topic') || getFromQuery('q') || getFromQuery('query') || getFromQuery('to[pic') )
    : (getFromBody('topic') || getFromBody('q') || getFromBody('query') || getFromBody('to[pic') )
  ) || '';

  if (!topic) return res.status(400).json({ error: 'topic(주제)가 필요합니다. 쿼리 파라미터 또는 POST 바디에 topic 값을 넣어 주세요.' });

  const itemsToFetch = 5;
  const COOLDOWN_MS = Number(process.env.GENERATE_TOPIC_COOLDOWN_MS) || 1000; // 각 상세 호출 사이 대기
  const MAX_ATTEMPTS = 3;

  // helper: fetch with retry (simple)
  async function fetchWithRetry(url, opts = {}, maxAttempts = MAX_ATTEMPTS) {
    let attempt = 0;
    while (++attempt <= maxAttempts) {
      try {
        const r = await fetch(url, opts);
        const text = await r.text().catch(() => null);
        if (r.ok) return { ok: true, status: r.status, text, headers: r.headers };
        // respect Retry-After for 429
        const ra = r.headers?.get ? r.headers.get('retry-after') : null;
        if (r.status === 429) {
          const waitMs = ra ? Number(ra) * 1000 : Math.min(1000 * 2 ** attempt, 5000);
          await new Promise((r) => setTimeout(r, waitMs));
          if (attempt >= maxAttempts) return { ok: false, status: r.status, text, headers: r.headers };
          continue;
        }
        if (r.status >= 500 && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
          continue;
        }
        return { ok: false, status: r.status, text, headers: r.headers };
      } catch (e) {
        if (attempt >= maxAttempts) return { ok: false, status: 'network_error', text: String(e) };
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
      }
    }
    return { ok: false, status: 'max_attempts' };
  }

  // parse RSS -> items (reused from existing implementation, trimmed)
  function parseRssToJson(rssXml, limit = 100) {
    try {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      const items = [];
      let match;
      let id = 1;
      while ((match = itemRegex.exec(rssXml)) !== null && id <= limit) {
        const itemContent = match[1];
        const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&') : '';
        const descMatch = itemContent.match(/<description>([\s\S]*?)<\/description>/);
        const summary = descMatch ? descMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&') : '';
        const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/);
        const link = linkMatch ? linkMatch[1].trim() : '';
        const pubDateMatch = itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const pubDate = pubDateMatch ? pubDateMatch[1].trim() : '';
        if (title && link) {
          items.push({ id, title, summary, link, pubDate });
          id++;
        }
      }
      return items;
    } catch (error) {
      console.error('RSS parsing error:', error);
      return [];
    }
  }

  try {
    // Google News RSS URL (한국 기준, 필요하면 locale 변경)
    const googleNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&when:24h&hl=ko&gl=KR&ceid=KR:ko`;
    const rssResp = await fetchWithRetry(googleNewsUrl, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!rssResp.ok) {
      const retryAfter = rssResp.headers?.get ? rssResp.headers.get('retry-after') : null;
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      return res.status(rssResp.status || 502).json({ error: 'Google News fetch failed', details: rssResp.text });
    }
    const allItems = parseRssToJson(rssResp.text || '', 20);
    if (!allItems.length) return res.status(500).json({ error: 'No news items found' });

    const selected = allItems.slice(0, itemsToFetch);

    // determine base URL to call internal endpoint (server-side)
    let baseUrl = null;
    if (process.env.VERCEL_URL) {
      baseUrl = `https://${process.env.VERCEL_URL}`;
    } else if (req.headers && req.headers.host) {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      baseUrl = `${proto}://${req.headers.host}`;
    } else {
      baseUrl = `http://localhost:${process.env.PORT || 3000}`;
    }

    const results = [];
    for (const item of selected) {
      // call internal generate-detail endpoint sequentially to avoid concurrency limits
      const detailUrl = `${baseUrl}/api/generate-detail?id=${encodeURIComponent(String(item.id))}&title=${encodeURIComponent(item.title)}`;

      const detailResp = await fetchWithRetry(detailUrl, { method: 'GET' }, MAX_ATTEMPTS);
      if (!detailResp.ok) {
        // if rate-limited, propagate Retry-After if present
        const ra = detailResp.headers?.get ? detailResp.headers.get('retry-after') : null;
        if (ra) res.setHeader('Retry-After', ra);
        // include partial info about failure for this item but continue to next
        results.push({
          item,
          detail: null,
          error: { status: detailResp.status, body: detailResp.text }
        });
      } else {
        let parsed = null;
        try {
          parsed = JSON.parse(detailResp.text);
        } catch (e) {
          parsed = { parseError: true, raw: detailResp.text };
        }
        results.push({ item, detail: parsed });
      }

      // wait between calls to reduce burst
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    }

    return res.status(200).json({ topic, count: results.length, results });
  } catch (e) {
    console.error('generate-topic-details error', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
