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

  // Simple in-memory cooldown guard to reduce rapid repeated calls from clients.
  // Note: Serverless functions are ephemeral and this is a best-effort protection.
  // It helps reduce quick client-side loops that trigger Gemini rate limits.
  if (!global._generateSummaryLastRequestAt) global._generateSummaryLastRequestAt = 0;
  const COOLDOWN_MS = 15000; // 15s cooldown between allowed requests (tunable)
  const now = Date.now();
  if (now - global._generateSummaryLastRequestAt < COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((COOLDOWN_MS - (now - global._generateSummaryLastRequestAt)) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: `Too many requests. Please wait ${retryAfterSec} seconds before retrying.` });
  }

  try {
    // mark the request time immediately to help prevent parallel rapid requests
    global._generateSummaryLastRequestAt = Date.now();

    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
        // NOTE: removed `tools` to avoid using features that might not be supported for all accounts.
      })
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();

      // If Gemini returns 429, propagate it and include Retry-After header when present
      if (apiResponse.status === 429) {
        const retryAfterHeader = apiResponse.headers.get('retry-after');
        if (retryAfterHeader) res.setHeader('Retry-After', retryAfterHeader);
        return res.status(429).json({ error: `Gemini API Rate Limit (429): ${errorText}` });
      }

      return res.status(apiResponse.status).json({ 
        error: `Gemini API 오류 (${apiResponse.status}): ${errorText}` 
      });
    }

    const data = await apiResponse.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    const jsonMatch = rawText ? rawText.match(/\[[\s\S]*\]/) : null;
    if (!jsonMatch) {
      return res.status(500).json({ 
        error: 'Gemini API로부터 올바른 JSON 형식의 응답을 받지 못했습니다.',
        rawText 
      });
    }

    const newsItems = JSON.parse(jsonMatch[0]);
    return res.status(200).json(newsItems);

  } catch (error) {
    console.error('Serverless Function Error:', error);

    // If the error looks like a fetch failure to Gemini, respond with 502/503 rather than retrying.
    return res.status(502).json({ 
      error: error.message || '서버 내부 오류가 발생했습니다.' 
    });
  }
}
