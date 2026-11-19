# Donian 개인 포트폴리오 홈페이지

GitHub Pages 기반 정적 포트폴리오 사이트입니다. 터미널 세션 UX로 오픈소스 프로젝트(16개)를 소개하고, 문의 게시판을 제공합니다.

- 배포 주소: [https://donian-kor.github.io](https://donian-kor.github.io)

## 주요 화면

- **터미널 세션**: 명령을 입력하거나 하단 프리셋 버튼을 눌러 결과를 확인합니다
  - `whoami` — 자기소개
  - `Get-History` — 커리어 로그
  - `Get-ChildItem .\projects` — 프로젝트 목록 (행 클릭 시 상세)
  - `Get-Content .\projects\이름` — 프로젝트 상세 열기
  - `music` — AI 음악 플레이어
  - `contact` — 게시판 (터미널 안에서 직접 렌더)
  - `clear` / `help`
  - 숨겨진 명령 `관리자` — 게시판 관리자 로그인 (`help`에는 노출되지 않음)
- **게시판**: 글 목록(10개 단위 페이지네이션), 작성·수정·삭제, 중첩 댓글/답글, 검색·필터, Cloudflare Turnstile
  - 댓글 내용 최대 100자 (화면 입력 + 워커 서버 검증)
- **프로젝트**: `projects.json` 기반 렌더, 카테고리 필터(전체/Android/PC/Web), 스크린샷 호버
- **부가**: Matrix 배경, CRT 효과, 방문자 카운터, 다크/모노 테마

## 파일 구조

```
index.html              터미널 셸 + 스타일 + 프로젝트 렌더 + 음악/Matrix
js/terminal.js          명령 registry, 타이핑 출력, help, 보안 화이트리스트, 관리자 인증
js/board.js             게시판 API 래퍼 + 목록/상세/작성/댓글 렌더
projects.json           프로젝트 데이터
board.html              레거시 게시판 페이지 (백업용, 변경 없이 보존)
worker/board-api.js     Cloudflare Worker 게시판 API (D1 + KV + rate limit)
worker/visitor-counter.js 방문자 카운터 Worker
assets/                 프로젝트 스크린샷
docs/                   참고 문서
```

## 로컬 실행

ES 모듈과 `fetch('projects.json')`를 사용하므로 `file://` 직접 열기는 지원되지 않습니다. 로컬 서버를 사용하세요.

```bash
python -m http.server 8080
# http://127.0.0.1:8080/index.html
```

게시판 API는 CORS가 `https://donian-kor.github.io`만 허용하므로, 로컬에서는 목록 데이터가 로드되지 않습니다(정상 동작).

## 배포

- **프론트엔드**: `main` 브랜치에 푸시하면 GitHub Pages에 자동 반영됩니다.
- **게시판 API**: 코드 변경 후 Cloudflare Worker를 별도 배포해야 합니다.

```bash
cd <배포 디렉터리>   # wrangler.toml 위치
npx wrangler deploy
```

`wrangler.toml`에는 D1 바인딩(`donian-board`), KV, rate limit이 설정되어 있습니다. 관리자 비밀번호 등 민감 정보는 저장소에 커밋하지 않고 Cloudflare Secrets로 관리합니다.

## 참고

- 게시판 API Origin: `https://donian-kor.github.io`
- Turnstile site key는 공개 값이며, secret key는 Cloudflare에 저장됩니다.
- `.admin-password.txt`, `.env` 등 민감 파일은 `.gitignore`에 포함되어 있습니다.
