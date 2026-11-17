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

## 자동 정리 (Cron)

조회 기록·카운터가 무한히 쌓이지 않도록 매일 자동 정리합니다.

- **보관 기간**: `post_views`(조회 기록) 30일, `rate_limits`(카운터) 만료 시
- **실행**: 매일 09:00 KST (`wrangler.toml` 의 `crons = ["0 0 * * *"]`)
- Worker `scheduled()` 핸들러가 처리
- 무료 사용량 영향: Worker 1회/일(≈0%), D1 쓰기 소량(무료 범위 내)

`wrangler.toml` 예시:
```toml
[triggers]
crons = ["0 0 * * *"]   # 매일 00:00 UTC = 09:00 KST
```

## 데이터 테이블

| 테이블 | 용도 |
|---|---|
| `posts` / `comments` | 게시글 / 댓글 (영구 보관, 직접 삭제 전까지 유지) |
| `post_views` | 조회수 중복 방지 (IP당 24시간 1회) — KV 대신 D1 |
| `rate_limits` | 레이트리밋 카운터 (글/댓글/수정/비번실패) — KV 대신 D1 |

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/posts?page=1&search=` | 목록 (페이지네이션, 검색) |
| GET | `/posts/:id` | 상세보기 (조회수 증가, 댓글 포함) |
| GET | `/posts/:id?password=` | 잠금 게시글 열람 (본인/관리자 비밀번호) |
| POST | `/posts` | 글쓰기 (name, password, title, content, is_locked) |
| DELETE | `/posts/:id` | 글 삭제 (password) |
| POST | `/posts/:id/comments` | 댓글 작성 (parent_id 로 답글) |
| DELETE | `/comments/:id` | 댓글 삭제 (password, 답글 포함 CASCADE) |

## 잠금(비공개) 기능

- 글쓰기 시 `is_locked` 체크 → 작성자와 관리자만 열람 가능
- 목록에 잠금 아이콘 표시
- 상세보기 진입 시 비밀번호 입력 → 작성자 비밀번호 또는 관리자 비밀번호로 열람
- 관리자 비밀번호는 Worker secret `ADMIN_PASSWORD` 로 설정하세요.
  - 소스·README·Git 이력에 비밀번호를 적지 않습니다.
  - 등록: `npx wrangler secret put ADMIN_PASSWORD` (값은 안전하게 직접 입력)

## 중첩 댓글(답글) 및 삭제 규칙

- 댓글에 `parent_id` 를 지정하면 해당 댓글의 **답글**로 등록 (계층 표시)
- 답글 삭제 시 **하위 답글도 함께 삭제** (CASCADE)
- **관리자 답변이 달린 게시글(완료)은 관리자만 삭제 가능**
  - 작성자 비밀번호로는 삭제 불가 (403)
  - 관리자 비밀번호로만 삭제 가능

## 관리자 게시글 사칭 차단 (IP 차단)

- 관리자 글쓰기 시 비밀번호는 **20자 랜덤 자동 생성**(읽기전용) → 아무도 게시글 비번을 모름
- 관리자는 **로그인 토큰**으로 수정·삭제 (비번 입력 불필요)
- **관리자 게시글(is_admin=1)에 비관리자가 게시글 비번으로 댓글** → 사칭/해킹으로 간주
  - "작성자" 뱃지 표시 안 함 (관리자 글은 작성자 뱃지 없음)
  - **해당 IP 전체 차단** (KV `ban:<ip>`, 90일) → 이후 모든 요청 403
  - 메시지: "해킹 및 불법봇사용으로 차단되었습니다."
- 참고: IP 차단은 VPN/다른 네트워크로 우회 가능(근본 한계). 정적 페이지(GitHub Pages) 로딩은 막을 수 없고, **모든 API 동작**이 차단됨.

## 보안

- **비밀번호**: SHA-256 해시 저장 (원본 비밀번호 미저장)
- **봇/크롤러 차단**: User-Agent 기반으로 Googlebot, curl, python-requests 등 쓰기 요청 차단
- **스팸 필터**: 링크 4개 이상, 같은 문자 20회 이상 반복, 2자 미만 내용 차단
- **욕설/비속어 필터**: [korean-profanity-resources](https://github.com/Tanat05/korean-profanity-resources) + [bad_word_list](https://github.com/hlog2e/bad_word_list) + LoL 필터링 리스트 + [Curse-detection-data](https://github.com/2runo/Curse-detection-data) 기반 **7,025개 단어**
  - `profanity-words.js` 파일에 목록 저장
  - 공백·특수문자로 우회한 변형도 탐지 (정규화 후 매칭)
  - 정상 단어 오탐 방지: 1글자 단어 및 "시간·박사·씹다·고추·망가·같은·먹은·대준다·좀만·전만·십팔·팔년" 등 자연어 제외
  - **실시간 하이라이트 + 등록 차단**: 작성 중 욕설/비속어 감지 시 해당 부분을 빨간색으로 강조하고 등록을 차단 (사용자가 수정한 후 재등록 가능)
  - `GET /profanity-list` 엔드포인트로 프론트에 목록 제공
- **레이트리밋**:
  - 게시글: IP당 시간당 3회
  - 댓글: IP당 시간당 5회
  - 읽기: IP당 분당 60회 (스크래핑 방지)
- **비밀번호 실패 차단**: IP당 일 3회 실패 시 차단 (2회째 경고 메시지, 관리자는 면제)
- **honeypot**: 숨은 필드(`botcheck`)로 봇 차단
- **DDoS**: Cloudflare 엣지에서 기본 DDoS 방어 + 위 레이트리밋
- **크롤링**: board.html `noindex` + API 읽기 레이트리밋
- **CORS Origin 검증**: `https://donian-kor.github.io` 만 허용 (그 외 출처 403)
- **Turnstile**: Cloudflare Turnstile 토큰 검증 (`TURNSTILE_SECRET_KEY` secret, 미설정 시 스킵)
- **Rate Limiting binding**: 엣지 폭주 방어 (60회/60초, KV 조회 없이 즉시 차단)
