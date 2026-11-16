// Cloudflare Worker: IP 기반 일 1회 방문자 카운터
// 배포 방법:
// 1. Cloudflare 대시보드 → Workers & Pages → Create → Worker
// 2. 이 코드를 붙여넣고 Deploy
// 3. Settings → Bindings → KV Namespace 추가 (변수명: COUNTER_KV)
// 4. index.html 의 VISITOR_COUNTER_URL 을 Worker URL 로 교체
//
// KV 네임스페이스 생성: Workers & Pages → KV → Create namespace (이름: visitor-counter)

export default {
  async fetch(request, env) {
    // 클라이언트 IP (Cloudflare가 제공)
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const date = new Date().toISOString().slice(0, 10); // UTC 날짜

    // IP + 날짜 해시 (원본 IP 저장 안 함)
    const data = new TextEncoder().encode(ip + '|' + date);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const ipHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);

    const seenKey = `seen:${date}:${ipHash}`;
    const totalKey = 'total';

    const seen = await env.COUNTER_KV.get(seenKey);
    let total = parseInt((await env.COUNTER_KV.get(totalKey)) || '0', 10);

    if (seen === null) {
      // 오늘 처음 보는 IP → 카운트 증가
      await env.COUNTER_KV.put(seenKey, '1', { expirationTtl: 172800 }); // 2일 TTL
      total += 1;
      await env.COUNTER_KV.put(totalKey, String(total));
    }

    return new Response(JSON.stringify({ count: total, date }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  },
};
