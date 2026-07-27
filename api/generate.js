export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
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
    현재 시각 기준으로 한국에서 가장 화제가 되고 있는 주요 뉴스 4건을 조사해줘.
    각 이슈별로 관련 기사들을 선별, 종합, 요약하여 반드시 아래의 JSON 형식으로만 응답해줘. 다른 설명이나 마크다운 문법 없이 순수 JSON 배열만 출력해야 해.

    [
      {
        "id": 1,
        "category": "카테고리 (예: IT/과학, 경제, 사회 등)",
        "title": "종합된 핵심 뉴스 제목",
        "summary": "핵심 내용 1~2줄 요약 (항상 노출될 내용)",
        "details": "뉴스에 대한 심층적이고 구체적인 설명 및 맥락 분석 (꺽쇠를 클릭했을 때 나타날 상세 내용)",
        "sources": [
          { "name": "언론사명1", "url": "원문기사URL1" },
          { "name": "언론사명2", "url": "원문기사URL2" }
        ]
      }
    ]
  `;

  try {
    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        tools: [{ googleSearch: {} }]
      })
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
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
    return res.status(500).json({ 
      error: error.message || '서버 내부 오류가 발생했습니다.' 
    });
  }
}
