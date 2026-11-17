# 방문자 카운터 (Cloudflare Worker)

IP당 하루 1회만 카운팅하는 방문자 카운터 백엔드입니다.

## 배포 절차

1. [Cloudflare 대시보드](https://dash.cloudflare.com) 로그인 → **Workers & Pages** → **Create** → **Create Worker**
2. Worker 이름을 `visitor-counter` 로 설정하고 **Deploy**
3. **Edit code** 버튼 클릭 → `visitor-counter.js` 내용 전체를 붙여넣기 → **Save and deploy**
4. **Settings** → **Bindings** → **Add** → **KV Namespace**
   - Variable name: `COUNTER_KV`
   - KV namespace: 새 네임스페이스 생성 (이름 `visitor-counter`)
5. 배포된 Worker URL 복사 (예: `https://visitor-counter.<subdomain>.workers.dev`)
6. `index.html` 의 `VISITOR_COUNTER_URL` 상수를 해당 URL 로 교체
7. Git commit & push → GitHub Pages 반영

## 동작 방식

- 클라이언트 IP 는 Cloudflare 가 제공하는 `cf-connecting-ip` 헤더로 확인
- IP + UTC 날짜를 SHA-256 해시하여 저장 (원본 IP 미저장, 개인정보 보호)
- 같은 IP 가 같은 UTC 날짜에 재접속하면 카운트 증가 없음
- **봇/크롤러(User-Agent 기반)는 카운트하지 않음** — Googlebot, Bingbot, curl, python-requests 등 제외
- KV 에 2일 TTL 로 저장되어 자동 만료
- CORS 허용 (`*`) 으로 정적 사이트에서 fetch 가능

## 무료 티어 한도

- 일 100,000 요청, 일 1,000 KV 쓰기 → 개인 포트폴리오에 충분
- KV 쓰기는 "새 IP" 접속 시에만 발생하므로 실제 한도는 더 여유 있음

## 배포 전 (미배포 상태)

`VISITOR_COUNTER_URL` 에 `YOUR-SUBDOMAIN` 이 포함되어 있으면 자동으로 hits.sh 배지로 폴백 표시됩니다.

---

# 게시판 API (Cloudflare Worker + D1)

비회원제 문의 게시판 백엔드입니다. `board-api.js` + `board-schema.sql` 사용.

## 배포 절차

1. D1 데이터베이스 생성:
   ```bash
   npx wrangler d1 create donian-board
   ```
2. 스키마 적용:
   ```bash
   npx wrangler d1 execute donian-board --remote --file=board-schema.sql
   ```
3. `wrangler.toml` 에 D1 바인딩 추가:
   ```toml
   [[d1_databases]]
   binding = "donian_board"
   database_name = "donian-board"
   database_id = "<생성된 ID>"
   ```
4. Worker 배포:
   ```bash
   npx wrangler deploy
   ```
5. `board.html` 의 `API_BASE` 상수를 배포된 Worker URL 로 교체

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/posts?page=1&search=` | 목록 (페이지네이션, 검색) |
| GET | `/posts/:id` | 상세보기 (조회수 증가, 댓글 포함) |
| GET | `/posts/:id?password=` | 잠금 게시글 열람 (본인/관리자 비밀번호) |
| POST | `/posts` | 글쓰기 (name, password, title, content, is_locked) |
| DELETE | `/posts/:id` | 글 삭제 (password) |
| POST | `/posts/:id/comments` | 댓글 작성 |
| DELETE | `/comments/:id` | 댓글 삭제 (password) |

## 잠금(비공개) 기능

- 글쓰기 시 `is_locked` 체크 → 작성자와 관리자만 열람 가능
- 목록에 잠금 아이콘 표시
- 상세보기 진입 시 비밀번호 입력 → 작성자 비밀번호 또는 관리자 비밀번호로 열람
- 관리자 비밀번호는 Worker secret `ADMIN_PASSWORD` 로 설정 (기본값: `donian-admin-2026`)

## 보안

- 비밀번호는 SHA-256 해시로 저장 (원본 비밀번호 미저장)
- honeypot 필드(`botcheck`)로 봇 차단
- IP당 시간당 10회 쓰기 제한 (KV 기반)
- CORS 허용 (`*`)
