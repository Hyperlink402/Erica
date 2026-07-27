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

    [
      {
        "id": 1,
        "category": "카테고리",
        "title": "뉴스 제목",
        "summary": "1~2줄 핵심 요약",
        "details": "구체적인 맥락 설명",
        "sources": [
          { "name": "언론사명", "url": "원문기사URL" }
        ]
      }
    ]
  `;

  try {
    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        //tools: [{ googleSearch: {} }]
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
