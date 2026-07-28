export default async function handler(req, res) {
  // Accept both GET and POST for flexibility
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const getFromQuery = (k) => (req.query && typeof req.query === 'object') ? req.query[k] : undefined;
  const getFromBody = (k) => (req.body && typeof req.body === 'object') ? req.body[k] : undefined;

  const id = getFromQuery('id') || getFromBody('id');
  const title = getFromQuery('title') || getFromBody('title') || '';
  const link = getFromQuery('link') || getFromBody('link') || getFromQuery('url') || getFromBody('url') || null;

  if (!id || !title) {
    return res.status(400).json({ error: 'id and title required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다. Vercel 환경변수 설정을 확인해 주세요.'
    });
  }

  // If a link is provided, we'll try to fetch the article HTML and extract main text.
  async function fetchPageText(url) {
    try {
      const resp = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!resp.ok) throw new Error(`Failed to fetch article: ${resp.status}`);
      const html = await resp.text();

      // Remove script/style blocks
      const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');

      // Try to extract <article>...</article>
      const articleMatch = cleaned.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
      let contentHtml = articleMatch ? articleMatch[1] : '';

      // If no article tag, fall back to collecting <main> or large content container
      if (!contentHtml) {
        const mainMatch = cleaned.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
        contentHtml = mainMatch ? mainMatch[1] : '';
      }

      // If still empty, collect first N <p> tags from body
      if (!contentHtml) {
        const pMatches = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].slice(0, 30);
        contentHtml = pMatches.map(m => m[1]).join('\n\n');
      }

      // Strip remaining tags and decode basic entities
      const text = contentHtml.replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\s{2,}/g, ' ')
        .trim();

      // Truncate to a reasonable length to avoid sending enormous prompts
      return text.slice(0, 16000);
    } catch (e) {
      console.warn('fetchPageText failed', e);
      return null;
    }
  }

  // cooldown and in-flight safety defaults
  const COOLDOWN_MS = Number(process.env.GENERATE_DETAIL_COOLDOWN_MS) || Number(process.env.GENERATE_SUMMARY_COOLDOWN_MS) || 15000;
  const MAX_IN_FLIGHT_MS = Number(process.env.GENERATE_DETAIL_MAX_IN_FLIGHT_MS) || 30000;

  // Optional Upstash Redis for cross-instance locking & caching
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || null;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;

  async function upstashFetch(path, method = 'GET', body = null) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash not configured');
    const url = `${UPSTASH_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  }

  async function redisGet(key) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    try {
      const r = await upstashFetch(`/get/${encodeURIComponent(key)}`);
      return r.result ?? null;
    } catch (e) {
      console.warn('Upstash GET failed', e);
      return null;
    }
  }

  async function redisSet(key, value, exSeconds = 300) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
    try {
      await upstashFetch(`/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}?ex=${exSeconds}`, 'POST');
      return true;
    } catch (e) {
      console.warn('Upstash SET failed', e);
      return false;
    }
  }

  async function tryAcquireLock(lockKey, ttlSec = 25) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
    try {
      const url = `${UPSTASH_URL}/set/${encodeURIComponent(lockKey)}/${encodeURIComponent('1')}?nx=true&ex=${ttlSec}`;
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
      const j = await res.json();
      return j.result === 'OK';
    } catch (e) {
      console.warn('Upstash lock failed', e);
      return false;
    }
  }

  async function releaseLock(lockKey) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
    try {
      await upstashFetch(`/del/${encodeURIComponent(lockKey)}`, 'POST');
    } catch (e) {
      console.warn('Upstash release lock failed', e);
    }
  }

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
      console.info(`Gemini detail attempt=${attempt} status=${resp.status} retry-after=${retryAfterHeader}`);

      if (resp.ok) {
        return { ok: true, rawBodyText: bodyText, headers };
      }

      if (resp.status === 429) {
        global._generateDetailLastRequestAt = Date.now();
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Math.min(1000 * 2 ** attempt, 10000);
        console.warn('Gemini 429 body:', bodyText);
        if (attempt >= maxAttempts) {
          return { ok: false, status: resp.status, bodyText, headers };
        }
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (resp.status >= 500 && attempt < maxAttempts) {
        const waitMs = Math.min(500 * 2 ** attempt, 5000);
        console.warn(`Server error ${resp.status}, retrying after ${waitMs}ms`, bodyText);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      return { ok: false, status: resp.status, bodyText, headers };
    }
    return { ok: false, status: 'max_attempts' };
  }

  // init globals
  if (!global._generateDetailLastRequestAt) global._generateDetailLastRequestAt = 0;
  if (typeof global._generateDetailInFlight === 'undefined') global._generateDetailInFlight = false;
  if (!global._generateDetailInFlightStartedAt) global._generateDetailInFlightStartedAt = 0;

  const now = Date.now();

  // safety: clear stale in-flight flag
  if (global._generateDetailInFlight && (now - global._generateDetailInFlightStartedAt > MAX_IN_FLIGHT_MS)) {
    console.warn('Clearing stale generate-detail in-flight flag after timeout');
    global._generateDetailInFlight = false;
    global._generateDetailInFlightStartedAt = 0;
  }

  // If another request is in-flight (same instance) and no Upstash present, return 429
  if (global._generateDetailInFlight && !UPSTASH_URL) {
    const retryAfterSeconds = 3;
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: '다른 상세 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.' });
  }

  // cooldown since last request
  if (now - global._generateDetailLastRequestAt < COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((COOLDOWN_MS - (now - global._generateDetailLastRequestAt)) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: `상세 정보 요청이 너무 잦습니다. ${retryAfterSec}초 후에 다시 시도해 주세요.` });
  }

  const cacheKey = `generate-detail:${encodeURIComponent(id)}:${Buffer.from(title).toString('base64').slice(0,64)}`;
  let acquiredLock = false;

  try {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      acquiredLock = await tryAcquireLock('generate-detail-inflight', 25);
      if (!acquiredLock) {
        const retryAfterSeconds = 3;
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ error: '다른 상세 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.' });
      }

      const cached = await redisGet(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return res.status(200).json(parsed);
        } catch (e) {
          console.warn('Failed to parse cached detail', e);
        }
      }
    }

    try {
      global._generateDetailInFlight = true;
      global._generateDetailInFlightStartedAt = Date.now();

      // If link is provided, attempt to fetch article text
      let articleText = null;
      if (link) {
        articleText = await fetchPageText(link);
        if (!articleText) {
          console.warn('Could not extract article text from link, proceeding with title-only prompt');
        }
      }

      // Build prompt: request concise key-point-only JSON response
      const promptParts = [];
      promptParts.push(`뉴스 제목: "${title}"`);
      if (link) promptParts.push(`원문 링크: ${link}`);
      if (articleText) {
        promptParts.push(`기사 본문(요약해서 사용; 너무 길면 앞부분만 사용):\n${articleText}`);
      } else {
        promptParts.push('기사 전문을 가져오지 못했으므로 제목 기반으로 가능한 한 정확히 요약해 주세요.');
      }

      promptParts.push(`다음 형식의 JSON만 출력하세요. 아무런 설명도 추가하지 마세요.\n{\n  "title": "...",\n  "summary": "한 문장 요약(한국어)",\n  "keyPoints": ["핵심 1", "핵심 2"],\n  "source": "원문 링크 또는 출처",\n  "note": "선택적 보조메모(출처 신뢰도 등)"\n}`);

      const promptText = promptParts.join('\n\n');

      const apiResponse = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
        }
      );

      if (!apiResponse.ok) {
        const headers = apiResponse.headers || {};
        const retryAfterHeader = headers.get ? headers.get('retry-after') : null;
        if (retryAfterHeader) res.setHeader('Retry-After', retryAfterHeader);
        global._generateDetailLastRequestAt = Date.now();
        const status = apiResponse.status || 429;
        return res.status(status).json({ error: `Gemini API Rate Limit or error (${status}): ${apiResponse.bodyText || apiResponse.rawBodyText}` });
      }

      const rawBodyText = apiResponse.rawBodyText;
      let data;
      try {
        data = JSON.parse(rawBodyText);
      } catch (e) {
        global._generateDetailLastRequestAt = Date.now();
        console.error('Failed to parse Gemini response JSON', e, rawBodyText);
        return res.status(500).json({ error: 'Gemini 응답을 파싱할 수 없습니다.', rawText: rawBodyText });
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || data.output?.[0]?.content?.text || null;
      if (!rawText) {
        global._generateDetailLastRequestAt = Date.now();
        return res.status(500).json({ error: 'Gemini 응답에서 텍스트를 찾을 수 없습니다.', rawData: data });
      }

      // Try to extract JSON substring from the model output
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        global._generateDetailLastRequestAt = Date.now();
        return res.status(500).json({ error: 'Gemini가 올바른 JSON을 반환하지 않았습니다.', rawText });
      }

      const detail = JSON.parse(jsonMatch[0]);

      // ensure some fields
      detail.title = detail.title || title;
      detail.source = detail.source || link || '';

      global._generateDetailLastRequestAt = Date.now();

      // cache detail for short period
      try {
        if (UPSTASH_URL && UPSTASH_TOKEN) {
          await redisSet(cacheKey, JSON.stringify(detail), 300);
        }
      } catch (e) {
        console.warn('Failed to set detail cache', e);
      }

      return res.status(200).json(detail);
    } catch (error) {
      console.error('generate-detail Serverless Function Error:', error);
      global._generateDetailLastRequestAt = Date.now();
      return res.status(502).json({ error: error?.message || '서버 내부 오류가 발생했습니다.' });
    } finally {
      global._generateDetailInFlight = false;
      global._generateDetailInFlightStartedAt = 0;
    }
  } finally {
    if (acquiredLock) {
      await releaseLock('generate-detail-inflight');
    }
  }
}
