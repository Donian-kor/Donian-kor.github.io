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
- KV 에 2일 TTL 로 저장되어 자동 만료
- CORS 허용 (`*`) 으로 정적 사이트에서 fetch 가능

## 무료 티어 한도

- 일 100,000 요청, 일 1,000 KV 쓰기 → 개인 포트폴리오에 충분
- KV 쓰기는 "새 IP" 접속 시에만 발생하므로 실제 한도는 더 여유 있음

## 배포 전 (미배포 상태)

`VISITOR_COUNTER_URL` 에 `YOUR-SUBDOMAIN` 이 포함되어 있으면 자동으로 hits.sh 배지로 폴백 표시됩니다.
