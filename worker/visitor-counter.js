// Cloudflare Worker: IP 기반 일 1회 방문자 카운터 (봇/크롤러 제외)
// 오늘 방문자 + 총 방문자 카운팅
// 배포 방법:
// 1. Cloudflare 대시보드 → Workers & Pages → Create → Worker
// 2. 이 코드를 붙여넣고 Deploy
// 3. Settings → Bindings → KV Namespace 추가 (변수명: COUNTER_KV)
// 4. index.html 의 VISITOR_COUNTER_URL 을 Worker URL 로 교체
//
// KV 네임스페이스 생성: Workers & Pages → KV → Create namespace (이름: visitor-counter)

// 봇/크롤러 User-Agent 패턴 (대소문자 무시)
const BOT_PATTERNS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /slurp/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /discordbot/i,
  /googlebot/i,
  /bingbot/i,
  /yandex/i,
  /baidu/i,
  /duckduck/i,
  /applebot/i,
  /petalbot/i,
  /semrush/i,
  /ahrefs/i,
  /mj12/i,
  /dotbot/i,
  /rogerbot/i,
  /screaming\s*frog/i,
  /headless/i,
  /phantom/i,
  /wget/i,
  /curl/i,
  /python-requests/i,
  /go-http-client/i,
  /java\//i,
];

function isBot(userAgent) {
  if (!userAgent) return true; // UA 없음 → 봇으로 간주
  return BOT_PATTERNS.some((re) => re.test(userAgent));
}

export default {
  async fetch(request, env) {
    const ua = request.headers.get('user-agent') || '';
    const bot = isBot(ua);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const date = new Date().toISOString().slice(0, 10);

    const totalKey = 'total';
    const todayKey = `daily:${date}`;

    // 봇/크롤러는 카운트하지 않음 (현재 값만 반환)
    if (bot) {
      const total = parseInt((await env.COUNTER_KV.get(totalKey)) || '0', 10);
      const today = parseInt((await env.COUNTER_KV.get(todayKey)) || '0', 10);
      return new Response(JSON.stringify({ total, today, date, bot: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }

    const data = new TextEncoder().encode(ip + '|' + date);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const ipHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);

    const seenKey = `seen:${date}:${ipHash}`;

    const seen = await env.COUNTER_KV.get(seenKey);
    let total = parseInt((await env.COUNTER_KV.get(totalKey)) || '0', 10);
    let today = parseInt((await env.COUNTER_KV.get(todayKey)) || '0', 10);

    if (seen === null) {
      // 오늘 처음 보는 IP → 오늘/총 모두 +1
      await env.COUNTER_KV.put(seenKey, '1', { expirationTtl: 172800 });
      total += 1;
      today += 1;
      await env.COUNTER_KV.put(totalKey, String(total));
      await env.COUNTER_KV.put(todayKey, String(today), { expirationTtl: 172800 });
    }

    return new Response(JSON.stringify({ total, today, date, bot: false }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  },
};