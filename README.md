# 실시간 AI 뉴스 브리핑 (Vercel 배포 버전)

Gemini API의 Google Search Grounding 기능과 Vercel Serverless Function을 활용하여 구축된 실시간 뉴스 요약 웹앱입니다.

## 파일 구성

```text
├── index.html          # 화이트 톤 UI 및 꺽쇠 토글 프론트엔드
├── api/
│   └── generate.js     # Gemini API 호출 서버리스 함수 (환경변수 GEMINI_API_KEY 사용)
├── package.json        # Node.js 프로젝트 설정
├── vercel.json         # Vercel 배포 설정
└── README.md           # 설명서
```

## Vercel 배포 순서

1. **GitHub 저장소에 올려 배포하기**:
   - 이 압축 파일의 해제된 내용 전체를 본인의 GitHub 저장소(Repository)에 푸시(Push)합니다.
   - [Vercel](https://vercel.com)에 로그인 후 **New Project**를 선택하고 해당 GitHub 저장소를 연결합니다.

2. **환경 변수(Environment Variables) 설정**:
   - Vercel의 프로젝트 설정 단계(또는 Project Settings > Environment Variables)에서 아래 변수를 등록합니다.
     - **Key**: `GEMINI_API_KEY`
     - **Value**: [Google AI Studio](https://aistudio.google.com/)에서 발급받은 API Key

3. **배포 완성**:
   - **Deploy** 버튼을 누르면 배포가 진행되며, 생성된 URL을 통해 바로 접속하실 수 있습니다.
##data base키
const firebaseConfig = {
  apiKey: "AIzaSyDGbrQclH1hQhcnRepyjeZcr36hf3mBwSs",
  authDomain: "erica-e67dd.firebaseapp.com",
  projectId: "erica-e67dd",
  storageBucket: "erica-e67dd.firebasestorage.app",
  messagingSenderId: "40085931746",
  appId: "1:40085931746:web:bbbf5f0040d8fcc7e7c0bb"
};
