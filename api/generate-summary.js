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

  const promptText = `
    현재 한국 주요 뉴스 4건을 조사해줘.
    결과는 설명 없이 오직 아래 JSON 배열 형식으로만 응답해줘.
    id, category, title, summary만 포함해줘.

    [
      {
        "id": 1,
        "category": "카테고리",
        "title": "뉴스 제목",
        "summary": "1~2줄 핵심 요약"
      }
    ]
  `;

  // Configurable cooldown (ms). 기본 15초로 설정되어 있으나 필요 시 환경변수로 조정 가능.
  const COOLDOWN_MS = Number(process.env.GENERATE_SUMMARY_COOLDOWN_MS) || 15_000;

  // Initialize globals for best-effort concurrency control in serverless env
  if (!global._generateSummaryLastRequestAt) global._generateSummaryLastRequestAt = 0;
  if (typeof global._generateSummaryInFlight === 'undefined') global._generateSummaryInFlight = false;

  const now = Date.now();

  // If another request is currently in-flight, immediately return a friendly 429
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
    // mark in-flight to prevent concurrent Gemini calls
    global._generateSummaryInFlight = true;

    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
          // tools omitted intentionally
        })
      }
    );

    // read body as text to handle non-JSON error payloads
    const rawBodyText = await apiResponse.text();

    if (!apiResponse.ok) {
      // If Gemini returns 429, propagate and record last request time to avoid immediate retrigger
      if (apiResponse.status === 429) {
        const retryAfterHeader = apiResponse.headers.get('retry-after');
        if (retryAfterHeader) res.setHeader('Retry-After', retryAfterHeader);

        // record last request time so subsequent callers hit cooldown
        global._generateSummaryLastRequestAt = Date.now();

        return res.status(429).json({ error: `Gemini API Rate Limit (429): ${rawBodyText}` });
      }

      // Other non-OK responses: forward status and message
      return res.status(apiResponse.status).json({
        error: `Gemini API 오류 (${apiResponse.status}): ${rawBodyText}`
      });
    }

    // success: parse json
    const data = JSON.parse(rawBodyText);
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
