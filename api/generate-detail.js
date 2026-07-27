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

  const promptText = `
    뉴스 제목: "${title}"
    이 기사의 구체적인 맥락 설명과 출처를 조사해줘.
    결과는 설명 없이 오직 아래 JSON 형식으로만 응답해줘.

    {
      "details": "구체적인 맥락 설명 (2~3문장)",
      "sources": [
        { "name": "언론사명", "url": "원문기사URL" }
      ]
    }
  `;

  try {
    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
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

    const jsonMatch = rawText ? rawText.match(/\{[\s\S]*\}/) : null;
    if (!jsonMatch) {
      return res.status(500).json({ 
        error: 'Gemini API로부터 올바른 JSON 형식의 응답을 받지 못했습니다.',
        rawText 
      });
    }

    const detail = JSON.parse(jsonMatch[0]);
    return res.status(200).json(detail);

  } catch (error) {
    console.error('Serverless Function Error:', error);
    return res.status(500).json({ 
      error: error.message || '서버 내부 오류가 발생했습니다.' 
    });
  }
}
