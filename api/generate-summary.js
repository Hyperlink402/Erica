export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ 
      error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다. Vercel 환경변수 설정을 확인해 주세요.' 
    });
  }

  // Get prompt from request (body or query). Provide a sensible default if missing.
  let promptText = (req.method === 'GET' ? req.query.prompt : req.body?.prompt) || '';
  if (!promptText) {
    promptText = `한국 주요 뉴스 4건을 간단한 JSON로 출력하세요:[{"id":1,"title":"","summary":""}]`;
  }

  // Configurable cooldown (ms). 기본 15초로 설정
  const COOLDOWN_MS = Number(process.env.GENERATE_SUMMARY_COOLDOWN_MS) || 15_000;

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
      console.info(`Gemini attempt=${attempt} status=${resp.status} retry-after=${retryAfterHeader}`);

      if (resp.ok) {
        return { ok: true, rawBodyText: bodyText, headers };
      }

      // 429: respect retry-after or use exponential backoff
      if (resp.status === 429) {
        global._generateSummaryLastRequestAt = Date.now();
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Math.min(1000 * 2 ** attempt, 5000);
        console.warn('Gemini 429 body:', bodyText);
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

  // Initialize globals for best-effort concurrency control in serverless env
  if (!global._generateSummaryLastRequestAt) global._generateSummaryLastRequestAt = 0;
  if (typeof global._generateSummaryInFlight === 'undefined') global._generateSummaryInFlight = false;

  const now = Date.now();

  // If another request is currently in-flight (same instance), immediately return a friendly 429
  if (global._generateSummaryInFlight) {
    const retryAfterSeconds = 5;
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: '다른 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.' });
  }

  // Enforce cooldown since last successful (or rate-limited) request
  if (now - global._generateSummaryLastRequestAt < COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((COOLDOWN_MS - (now - global._generateSummaryLastRequestAt)) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: `요청이 너무 잦습니다. ${retryAfterSec}초 후에 다시 시도해 주세요.` });
  }

  try {
    // mark in-flight to prevent concurrent Gemini calls in this instance
    global._generateSummaryInFlight = true;

    const apiResponse = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
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
      return res.status(status).json({ error: `Gemini API Rate Limit or error (${status}): ${apiResponse.bodyText || apiResponse.rawBodyText}` });
    }

    // success: parse json
    const rawBodyText = apiResponse.rawBodyText;
    let data;
    try {
      data = JSON.parse(rawBodyText);
    } catch (e) {
      global._generateSummaryLastRequestAt = Date.now();
      console.error('Failed to parse Gemini response JSON', e, rawBodyText);
      return res.status(500).json({ error: 'Gemini 응답을 파싱할 수 없습니다.', rawText: rawBodyText });
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const jsonMatch = rawText ? rawText.match(/\[[\s\S]*\]/) : null;
    if (!jsonMatch) {
      // record last request time to avoid immediate retry loops
      global._generateSummaryLastRequestAt = Date.now();
      return res.status(500).json({
        error: 'Gemini API로부터 올바른 JSON 형식의 응답을 받지 못했습니다.',
        rawText
      });
    }

    const newsItems = JSON.parse(jsonMatch[0]);

    // successful response: record last success time (enable cooldown)
    global._generateSummaryLastRequestAt = Date.now();

    return res.status(200).json(newsItems);
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
