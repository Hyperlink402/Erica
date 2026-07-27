export default async function handler(req, res) {
  // 테스트용 목업 데이터 반환 (Gemini API를 호출하지 않으므로 에러 0%)
  const mockNews = [
    {
      "id": 1,
      "category": "IT/과학",
      "title": "테스트 뉴스: 웹 애플리케이션 정상 작동 확인",
      "summary": "화이트 톤 UI와 꺽쇠 토글 기능이 올바르게 출력되는지 확인하는 테스트용 데이터입니다.",
      "details": "이 영역은 꺽쇠 버튼을 누르면 나타나는 상세 브리핑 영역입니다.\n\nAPI 할당량 초과 에러 없이 UI 디자인과 슬라이드 토글 동작이 제대로 작동하는지 바로 확인하실 수 있습니다.",
      "sources": [
        { "name": "테스트 언론사", "url": "https://vercel.com" }
      ]
    },
    {
      "id": 2,
      "category": "경제",
      "title": "서버리스 함수 및 프론트엔드 연동 완료",
      "summary": "Vercel /api/generate 엔드포인트와 index.html이 정상적으로 통신하고 있습니다.",
      "details": "새로고침 버튼을 누르면 이 화면이 다시 로딩되며, 각 카드의 우측 꺽쇠를 클릭하면 상세 내용이 부드럽게 펼쳐집니다.",
      "sources": [
        { "name": "Vercel Docs", "url": "https://vercel.com/docs" }
      ]
    }
  ];

  return res.status(200).json(mockNews);
}
