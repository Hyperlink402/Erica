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

  // ------------------ Korean tokenizer (lightweight) ------------------
  // Purpose: approximate tokenization for Korean and mixed text without
  // adding external dependencies. This is an estimate used to warn or
  // shorten prompts to avoid hitting model token limits.
  function koreanTokenizer(text) {
    if (!text) return [];
    // Match Hangul runs, Latin words, numbers, or single non-space chars.
    // Uses Unicode property escapes; Node.js supports this in modern versions.
    try {
      return text.match(/\p{Script=Hangul}+|\p{Letter}+|\d+|[^\s]/gu) || [];
    } catch (e) {
      // Fallback if Unicode property escapes are not supported
      return text.split(/\s+/).flatMap(t => t.split(/(?=[^\p{L}\p{N}])|(?<=[^\p{L}\p{N}])/u)).filter(Boolean);
    }
  }

  function estimateTokensByChars(text) {
    // Conservative fallback estimate: 1 token ~= 2 characters for Korean-heavy text.
    // This provides a cheap estimate if tokenizer isn't precise enough.
    if (!text) return 0;
    const length = text.length;
    return Math.ceil(length / 2);
  }

  function estimateTokens(text) {
    const tokens = koreanTokenizer(text);
    // Use tokenizer length when available, otherwise fallback to char-based estimate
    if (tokens && tokens.length > 0) return tokens.length;
    return estimateTokensByChars(text);
  }
  // --------------------------------------------------------------------

  let promptText = `한국 주요 뉴스 4건을 JSON 형식으로:[{"id":1,"category":"","title":"","summary":"","details":"","sources":[{"name":"","url":""}]}]`;

  // check estimated tokens for prompt and trim if too large
  const PROMPT_TOKEN_WARN = Number(process.env.PROMPT_TOKEN_WARN) || 800; // warn threshold
  const PROMPT_TOKEN_MAX = Number(process.env.PROMPT_TOKEN_MAX) || 1200; // hard max for safety
  const estimated = estimateTokens(promptText);
  if (estimated > PROMPT_TOKEN_WARN) {
    console.info(`generate-summary: prompt estimated tokens=${estimated} (exceeds warn ${PROMPT_TOKEN_WARN})`);
  }

  if (estimated > PROMPT_TOKEN_MAX) {
    // fallback to the shortest possible prompt to reduce tokens
    console.warn(`generate-summary: trimming prompt from estimated ${estimated} tokens to safe minimal prompt`);
    promptText = `한국 주요 뉴스 4건을 간단한 JSON로 출력하세요:[{"id":1,"title":"","summary":""}]`;
  }

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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
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
