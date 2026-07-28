export default async function handler(req, res) {
  const { id, title } = req.query;

  if (!id || !title) {
    return res.status(400).json({ error: 'id and title required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다. Vercel 환경변수 설정을 확인해 주세요.'
    });
  }

  const promptText = `뉴스 제목: "${title}"
응답은 오직 JSON(한국어) 형태만 반환하세요:
{"details":"한국어, 2~3문장","sources":[{"name":"언론사명","url":"원문기사URL"}]}
출처 없으면 "sources":[]로 반환하세요. 다른 텍스트 금지.`;

  // cooldown and in-flight safety defaults
  const COOLDOWN_MS = Number(process.env.GENERATE_DETAIL_COOLDOWN_MS) || Number(process.env.GENERATE_SUMMARY_COOLDOWN_MS) || 15000;
  const MAX_IN_FLIGHT_MS = Number(process.env.GENERATE_DETAIL_MAX_IN_FLIGHT_MS) || 30000;

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

  // if another request is in-flight, return 429
  if (global._generateDetailInFlight) {
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

  try {
    global._generateDetailInFlight = true;
    global._generateDetailInFlightStartedAt = Date.now();

    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          temperature: 0.0,
          maxOutputTokens: 160,
          candidateCount: 1
        })
      }
    );

    const rawBodyText = await apiResponse.text();

    if (!apiResponse.ok) {
      // handle rate limit
      if (apiResponse.status === 429) {
        const retryAfterHeader = apiResponse.headers.get('retry-after');
        if (retryAfterHeader) res.setHeader('Retry-After', retryAfterHeader);

        // record last request time to trigger cooldown
        global._generateDetailLastRequestAt = Date.now();

        return res.status(429).json({ error: `Gemini API Rate Limit (429): ${rawBodyText}` });
      }

      return res.status(apiResponse.status).json({ error: `Gemini API 오류 (${apiResponse.status}): ${rawBodyText}` });
    }

    // parse successful response
    let data;
    try {
      data = JSON.parse(rawBodyText);
    } catch (e) {
      // unexpected non-JSON body
      global._generateDetailLastRequestAt = Date.now();
      return res.status(500).json({ error: 'Gemini 응답을 파싱할 수 없습니다.', rawText: rawBodyText });
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || data.output?.[0]?.content?.text || null;
    if (!rawText) {
      global._generateDetailLastRequestAt = Date.now();
      return res.status(500).json({ error: 'Gemini 응답에서 텍스트를 찾을 수 없습니다.', rawData: data });
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      global._generateDetailLastRequestAt = Date.now();
      return res.status(500).json({ error: 'Gemini가 올바른 JSON을 반환하지 않았습니다.', rawText });
    }

    const detail = JSON.parse(jsonMatch[0]);

    // success: record last request time
    global._generateDetailLastRequestAt = Date.now();

    return res.status(200).json(detail);
  } catch (error) {
    console.error('generate-detail Serverless Function Error:', error);
    global._generateDetailLastRequestAt = Date.now();
    return res.status(502).json({ error: error?.message || '서버 내부 오류가 발생했습니다.' });
  } finally {
    global._generateDetailInFlight = false;
    global._generateDetailInFlightStartedAt = 0;
  }
}
