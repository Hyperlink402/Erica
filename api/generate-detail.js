export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const getFromQuery = (k) => (req.query && typeof req.query === 'object') ? req.query[k] : undefined;
  const getFromBody = (k) => (req.body && typeof req.body === 'object') ? req.body[k] : undefined;

  const id = getFromQuery('id') || getFromBody('id');
  const title = getFromQuery('title') || getFromBody('title') || '';
  const link = getFromQuery('link') || getFromBody('link') || getFromQuery('url') || getFromBody('url') || '';

  if (!id || !title) {
    return res.status(400).json({ error: 'id and title required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다.'
    });
  }

  try {
    // 빠른 응답을 위한 프롬프트 구성 (details 및 sources 구조 명시)
    const promptText = `
뉴스 제목: "${title}"
원문 링크: "${link}"

위 뉴스의 내용을 바탕으로 상세 브리핑 작성 및 JSON 형식으로만 응답하세요. 다른 설명은 제외하세요.
{
  "details": "뉴스에 대한 핵심 배경과 상세 내용을 3~4문장의 깔끔한 단락으로 작성해 주세요.",
  "sources": [
    { "name": "원문 보기", "url": "${link || 'https://news.google.com'}" }
  ]
}
`;

    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      }
    );

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      return res.status(apiResponse.status).json({ error: `Gemini API 오류: ${errText}` });
    }

    const data = await apiResponse.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'JSON 응답 생성 실패', rawText });
    }

    const detail = JSON.parse(jsonMatch[0]);

    // undefined 방지를 위한 기본값 보장
    const responsePayload = {
      id: id,
      title: title,
      details: detail.details || '상세 브리핑 내용을 불러오지 못했습니다.',
      sources: Array.isArray(detail.sources) && detail.sources.length > 0 
        ? detail.sources 
        : [{ name: 'Google News', url: link || 'https://news.google.com' }]
    };

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('generate-detail error:', error);
    return res.status(500).json({ error: error?.message || '서버 내부 오류가 발생했습니다.' });
  }
}
