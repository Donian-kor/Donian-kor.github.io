# index.html 모듈화 베타 계획

- 작성일: 2026-11-19
- 상태: **베타 / 계획 확정 전**
- 대상: Donian 포트폴리오 홈페이지 (현재 저장소)

## 1. 현재 상태

- `index.html`: 인터랙티브 터미널 UI. HTML 한 파일 안에 스타일과 스크립트가 모두 인라인으로 들어 있음 (약 628줄)
- `board.html`: 기존 게시판 페이지 (약 2023줄). CRUD·댓글·관리자 인증 로직이 전부 인라인
- `worker/board-api.js`: Cloudflare Worker 게시판 API. 목록 API는 `pageSize = 10`으로 하드코딩
- 게시판 API CORS는 `https://donian-kor.github.io`만 허용 → 로컬(`127.0.0.1`)에서는 목록 데이터가 로드되지 않음 (기존 동작)

### 문제점

- `index.html`에 터미널 출력, 명령 처리, 프로젝트 렌더, 음악 플레이어, Matrix 배경, 방문자 카운터가 뒤섞여 있어 수정 범위를 찾기 어려움
- 게시판을 같은 컨셉으로 편입하려면 코드를 더 넣어야 하는데, 그대로 추가하면 파일이 더 커짐
- 게시판 로직을 재사용할 방법이 없어 `board.html`과 메인이 중복됨

## 2. 목표

1. `index.html`은 터미널 **셸** 역할만 수행하도록 얇게 유지
2. 기능별로 JS 모듈을 분리해 역할과 의존 관계를 명확히 함
3. 게시판을 iframe 없이 **프로젝트 목록과 같은 UI**로 메인 터미널에 편입
4. `board.html`은 기존 동작을 유지하는 백업/레거시 링크용으로 보존
5. 워커(API)는 변경하지 않음 → 게시판은 페이지당 10개 + 기존 페이지네이션 유지

## 3. 목표 파일 구조

```
index.html            터미널 셸. 모듈 초기화만 담당
css/terminal.css      디자인 토큰·터미널 컴포넌트 스타일 (3단계)
js/terminal.js        명령 registry, 타이핑 출력, help, 보안 화이트리스트, 관리자 명령
js/board.js           게시판 API 래퍼 + 목록/상세/작성·수정/댓글 렌더
js/projects.js        projects.json 로드, 프로젝트 목록/모달 (2단계)
js/music.js           YouTube 음악 플레이어 (2단계)
js/matrix.js          Matrix 캔버스 배경 (2단계)
board.html            기존 파일 유지 (백업)
worker/board-api.js   변경 없음
```

## 4. 단계별 계획

### 1단계 (우선): 게시판 + 명령 모듈화

**`js/terminal.js` (신규)**

- 기존 `runCommand`, `typeLine`, `typeHtmlEcho`, `typeHelpLine`, `help` 목록, 명령 화이트리스트를 모듈로 이동
- `initTerminal(ctx)` 형태로 출력 영역(`#terminal-output`), 스트림 영역, 음악 패널, 모달 등 필요한 참조를 주입받음
- `contact` 명령: `js/board.js`를 동적으로 import하여 게시판을 **출력 영역에 직접 렌더** (iframe 사용 안 함)
- 숨겨진 관리자 명령:
  - 명령어는 상수 `ADMIN_CMD = '관리자'`로 분리 (차후 변경 용이)
  - `help` 목록에는 노출하지 않음
  - 비밀번호는 화면에 에코하지 않음
  - `POST /admin/verify` 호출 후 성공 시 `sessionStorage['board_admin_token']` 저장
  - 게시판 모듈과 같은 origin이므로 토큰 공유됨

**`js/board.js` (신규)**

- `/posts`, `/posts/:id`, `/comments`, `/admin/verify` 등 API 래퍼
- 프로젝트 목록과 동일한 행 UI: `수정일 / 제목 / 작성자 / 조회`
- 페이지당 10개 + 기존 페이지네이션 유지 (`pageSize`는 워커가 결정)
- 상세 보기, 작성/수정 폼, 댓글을 터미널 패널 스타일로 렌더
- 관리자 로그인은 `terminal.js` 담당, 이 모듈은 `sessionStorage` 토큰을 읽기만 함

**`index.html`**

- `<script type="module">`로 `js/terminal.js` 초기화
- 명령 관련 인라인 코드 제거. 음악·Matrix는 이 단계에서 인라인 유지

### 2단계: 나머지 기능 분리

- `js/projects.js`: `projects.json` fetch, 카테고리 필터, 프로젝트 목록/모달
- `js/music.js`: 음악 목록 로드, 재생/일시정지 아이콘 전환
- `js/matrix.js`: Matrix 캔버스 애니메이션 (모바일 최적화 로직 포함)

### 3단계: 스타일 분리

- 인라인 `<style>`을 `css/terminal.css`로 이동
- 디자인 토큰(`--bg`, `--panel`, `--emerald`, `--amber`, `--fs`)을 한 곳에서 관리
- CRT 레이어, 터미널 창, 명령 버튼, 목록 행, 모달 스타일 정리

## 5. 제약 사항

- 모든 `id` / `class` / `data-*` / 이벤트 핸들러 / API 호출 로직은 **변경 금지**
- 한국어 문구, 링크, 이메일, 메타 정보 유지
- 새 라이브러리·빌드 도구·프레임워크 추가 금지 (CDN 구성 유지)
- ES 모듈은 `file://` 직접 실행에서 로드되지 않음 → 로컬 서버 또는 GitHub Pages 환경 필요
- 게시판 API CORS 제한으로 로컬에서는 목록 데이터가 로드되지 않음 (배포 환경에서 정상)
- `board.html`은 삭제하지 않고 기존 상태로 보존

## 6. 검증 방법

- `node --check js/*.js` 로 모듈 문법 검사
- `python check_html.py index.html board.html` 로 HTML/CSS 균형 검사
- 로컬 서버(`http://127.0.0.1:8080`)에서:
  - `contact` 명령 → 게시판 목록 UI가 터미널 안에 직접 렌더되는지 확인
  - `관리자` 명령 → 비밀번호 입력 후 `sessionStorage` 토큰 저장 확인
  - `help`에 관리자 명령이 노출되지 않는지 확인
- 게시판 데이터 로딩 실패는 로컬 CORS 때문에 발생하는 정상 동작으로 간주

## 7. 현재 결정 사항

- 게시판 목록: **10개 + 페이지네이션 유지** (워커 수정 없음)
- 게시판 진입: **`board` 명령 추가 없이 기존 `contact` 명령 사용**
- 관리자 로그인: **숨겨진 `관리자` 명령**, `help`에는 미노출
- `board.html`: **그대로 보존**
- 모듈 범위: **board + 터미널 명령까지** (1단계)
- 이 문서는 베타이며, 구현 중 세부 구조는 조정될 수 있음
