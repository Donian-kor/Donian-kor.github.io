// 게시판 API Worker (Cloudflare Workers + D1)
// 비회원제: 이름(선택) + 비밀번호(삭제용)
// 잠금(비공개): 작성자 또는 관리자만 열람 가능
// 보안: 봇/크롤러 차단, IP 레이트리밋, 스팸 필터, Turnstile, Origin 검증

const ALLOWED_ORIGIN = 'https://donian-kor.github.io';

// 게시글 상태: 일반 사용자가 선택 가능한 값 (알림/완료는 자동 파생)
const POST_STATUSES = ['question', 'bug', 'request'];
const FILTER_STATUSES = ['notice', ...POST_STATUSES, 'done'];

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

// 관리자 세션 쿠키 읽기 (HttpOnly, cross-site → SameSite=None; Secure)
const ADMIN_COOKIE = 'donian_admin';
function getAdminCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + ADMIN_COOKIE + '=([^;]+)'));
  return m ? m[1] : '';
}
function adminCookieSet(id) {
  // Max-Age/Expires 없음 = 세션 쿠키 → 브라우저 닫으면 삭제
  return ADMIN_COOKIE + '=' + id + '; Path=/; HttpOnly; Secure; SameSite=None';
}
function adminCookieClear() {
  return ADMIN_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0';
}

// 봇/크롤러 User-Agent 패턴
const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /slurp/i, /facebookexternalhit/i,
  /twitterbot/i, /linkedinbot/i, /whatsapp/i, /telegrambot/i, /discordbot/i,
  /googlebot/i, /bingbot/i, /yandex/i, /baidu/i, /duckduck/i, /applebot/i,
  /petalbot/i, /semrush/i, /ahrefs/i, /mj12/i, /dotbot/i, /rogerbot/i,
  /headless/i, /phantom/i, /wget/i, /curl/i, /python-requests/i,
  /go-http-client/i, /java\//i,
];

function isBot(ua) {
  if (!ua) return true;
  return BOT_PATTERNS.some((re) => re.test(ua));
}

// Cloudflare Turnstile 검증
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) return { success: true };
  if (!token) return { success: false, errorCodes: ['missing-input-response'] };
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return await res.json(); // { success, error-codes }
}

// 엣지 Rate Limiting binding (폭주 방어)
async function rateLimitEdge(ip, env) {
  if (!env.RATE_LIMITER) return true; // binding 없으면 스킵
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  return success;
}

// 욕설/비속어 목록 (프론트 하이라이팅용 /profanity-list, 서버 차단용)
// 도메인 확장자(.으로 시작)는 이메일 검증 전용이므로 비속어 필터에서 제외
import PROFANITY_RAW from './profanity-words.js';
const PROFANITY = PROFANITY_RAW.split('\n').map((w) => w.trim()).filter((w) => w && !w.startsWith('.'));

function normalizeText(s) {
  return String(s).toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

const PROFANITY_NORM = PROFANITY.map((w) => normalizeText(w)).filter(Boolean);

function hasProfanity(text) {
  const n = normalizeText(text);
  return PROFANITY_NORM.some((w) => n.includes(w));
}

// 작성자 이름 사칭 방지 (관리자/운영자 등) — 욕설 목록과 분리해 이름에만 적용
const IMPERSONATION_NAMES = [
  '관리자','운영자','사이트관리자','사이트관리','운영매니저','매니저','총감독','감독자',
  '관리','운영','운영진','운영팀','관리팀','관리자님','운영자님','슈퍼관리자','최고관리자',
  '총관리자','수석관리자','웹마스터','마스터','관리원','감독','감독관','총감독관','매니저님',
  '사이트운영자','시스템관리자','관리계정','운영계정','공식',
  'admin','administrator','gm','siteadmin','superadmin','manager','operator','moderator',
  'mod','owner','webmaster','root','system','staff','support','supervisor','director',
  'generalmanager','sitemanager','operationsmanager','adminteam','official','sysadmin',
  'sysop','superuser','siteowner','siteoperator','headadmin','headmod','leadmod','gamemaster',
  // 관리자 이름 'Donian' 혼동 유발 변형 (타이포스쿼팅)
  'donian','monian','nonian','ponian','donnian','dunian','bonian','conian','gonian','honian',
  'jonian','lonian','ronian','sonian','tonian','vonian','wonian','xonian','yonian','zonian',
  'doonian','doniian','doniaan','doniann','donia','dnian','doian','donien','doniun','donaian',
  '도니안'
];
const IMPERSONATION_NORM = IMPERSONATION_NAMES.map(normalizeText).filter(Boolean);
function isImpersonationName(name) {
  const n = normalizeText(name);
  if (!n) return false;
  // 2글자 이상 모두 포함 매칭 ("운영", "관리", "gm" 등이 섞여도 차단)
  return IMPERSONATION_NORM.some((w) => [...w].length >= 2 && n.includes(w));
}

const charLen = (s) => [...String(s)].length;

async function hashPassword(pw) {
  const salt = 'donian-board-v1';
  const data = new TextEncoder().encode(salt + ':' + pw);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }

    // Origin 검증: POST/PUT/DELETE 는 허용된 출처만
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const origin = request.headers.get('Origin');
      if (origin !== ALLOWED_ORIGIN) {
        return json({ error: '허용되지 않은 출처입니다.' }, 403);
      }
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ua = request.headers.get('user-agent') || '';

    // IP 차단 (해킹/불법봇) - KV 저장
    async function isBanned() {
      try { return !!(await env.COUNTER_KV.get('ban:' + ip)); } catch (e) { return false; }
    }
    async function banIp() {
      try { await env.COUNTER_KV.put('ban:' + ip, String(Date.now()), { expirationTtl: 90 * 24 * 60 * 60 }); } catch (e) {}
    }
    if (await isBanned()) return json({ error: '해킹 및 불법봇사용으로 차단되었습니다.' }, 403);

    // IP당 쓰기 제한: 시간당 N회 (D1 저장 → KV 안 씀)
    async function rateLimitWrite(action, limit) {
      const key = `w:${action}:${ip}`;
      const now = Date.now();
      const WINDOW = 60 * 60 * 1000; // 1시간
      const row = await env.donian_board
        .prepare('SELECT count, expires_at FROM rate_limits WHERE key = ?')
        .bind(key)
        .first();
      const valid = row && row.expires_at > now;
      const count = valid ? row.count : 0;
      if (count >= limit) return false;
      const next = count + 1;
      const expires = valid ? row.expires_at : now + WINDOW;
      await env.donian_board
        .prepare(`INSERT INTO rate_limits (key, count, expires_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`)
        .bind(key, next, expires)
        .run();
      return true;
    }

    // 비밀번호 실패 추적 (KST 일 단위, 일 3회 실패 시 차단) - D1 저장
    const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const failKey = () => `fail:${kstDate}:${ip}`;
    async function getFailCount() {
      const row = await env.donian_board
        .prepare('SELECT count, expires_at FROM rate_limits WHERE key = ?')
        .bind(failKey())
        .first();
      return (row && row.expires_at > Date.now()) ? row.count : 0;
    }
    async function recordFail() {
      const key = failKey();
      const now = Date.now();
      const row = await env.donian_board
        .prepare('SELECT count, expires_at FROM rate_limits WHERE key = ?')
        .bind(key)
        .first();
      const valid = row && row.expires_at > now;
      const count = valid ? row.count : 0;
      const next = count + 1;
      await env.donian_board
        .prepare(`INSERT INTO rate_limits (key, count, expires_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`)
        .bind(key, next, now + 2 * 24 * 60 * 60 * 1000) // 2일
        .run();
      return next;
    }
    async function isBlocked() {
      return (await getFailCount()) >= 3;
    }

    // IP당 읽기 제한: 분당 60회 (Rate Limiting binding 사용 → KV 안 씀)
    async function rateLimitRead() {
      if (!env.RATE_LIMITER) return true; // binding 없으면 스킵
      const { success } = await env.RATE_LIMITER.limit({ key: 'r:' + ip });
      return success;
    }

    // 읽기 요청 전체에 레이트리밋 적용
    if (method === 'GET' && !(await rateLimitRead())) {
      return json({ error: '요청이 너무 많습니다. 잠시 후 시도하세요.' }, 429);
    }

    // 스팸 내용 검사
    function spamCheck(text) {
      if (!text) return null;
      // URL 개수 (http/https/www)
      const urls = text.match(/https?:\/\/|www\./gi) || [];
      if (urls.length > 3) return '링크가 너무 많습니다.';
      // 같은 문자 20회 이상 반복
      if (/(.)\1{19,}/.test(text)) return '비정상적인 반복 문자열입니다.';
      return null;
    }

    // GET /profanity-list - 프론트 하이라이팅용 단어 목록
    if (method === 'GET' && path === '/profanity-list') {
      return new Response(JSON.stringify({ words: PROFANITY }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Credentials': 'true',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // POST /admin/verify - 관리자 비밀번호 확인 후 임시 토큰 발급
    if (method === 'POST' && path === '/admin/verify') {
      // brute-force 방어: IP당 24시간에 3회 실패 시 차단
      const alKey = `adminlogin:${ip}`;
      const nowTs = Date.now();
      const WINDOW = 24 * 60 * 60 * 1000; // 24시간
      const alRow = await env.donian_board
        .prepare('SELECT count, expires_at FROM rate_limits WHERE key = ?')
        .bind(alKey)
        .first();
      const alValid = alRow && alRow.expires_at > nowTs;
      const fails = alValid ? alRow.count : 0;
      if (fails >= 3) return json({ ok: false, error: '로그인 시도가 너무 많습니다. 24시간 후 다시 시도하세요.' }, 429);
      const body = await request.json().catch(() => ({}));
      const pw = body.password || '';
      if (env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD) {
        // 성공 → 실패 카운터 초기화
        await env.donian_board.prepare('DELETE FROM rate_limits WHERE key = ?').bind(alKey).run();
        const token = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
        const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
        await env.COUNTER_KV.put('admin_token:' + token, 'admin', { expirationTtl: 3600 });
        await env.COUNTER_KV.put('admin_session:' + sessionId, 'admin', { expirationTtl: 3600 });
        return json({ ok: true, token }, 200, { 'Set-Cookie': adminCookieSet(sessionId) });
      }
      // 실패 → 누적
      const next = fails + 1;
      const expires = alValid ? alRow.expires_at : nowTs + WINDOW;
      await env.donian_board
        .prepare(`INSERT INTO rate_limits (key, count, expires_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`)
        .bind(alKey, next, expires)
        .run();
      return json({ ok: false, error: '비밀번호가 일치하지 않습니다.' });
    }

    // POST /admin/keepalive - 관리자 세션 TTL 연장 (쿠키 세션 + 기존 토큰 모두 지원)
    if (method === 'POST' && path === '/admin/keepalive') {
      const body = await request.json().catch(() => ({}));
      const tk = body.token || '';
      const sid = getAdminCookie(request);
      let extended = false;
      if (sid && (await env.COUNTER_KV.get('admin_session:' + sid))) {
        await env.COUNTER_KV.put('admin_session:' + sid, 'admin', { expirationTtl: 3600 });
        extended = true;
      }
      if (tk && (await isAdminToken(tk))) {
        await env.COUNTER_KV.put('admin_token:' + tk, 'admin', { expirationTtl: 3600 });
        extended = true;
      }
      return json({ ok: extended });
    }

    // POST /admin/logout - 세션 쿠키 및 토큰 즉시 폐기
    if (method === 'POST' && path === '/admin/logout') {
      const body = await request.json().catch(() => ({}));
      const tk = body.token || '';
      const sid = getAdminCookie(request);
      if (sid) await env.COUNTER_KV.delete('admin_session:' + sid);
      if (tk) await env.COUNTER_KV.delete('admin_token:' + tk);
      return json({ ok: true }, 200, { 'Set-Cookie': adminCookieClear() });
    }

    // 관리자 세션 유효성: 쿠키 세션 우선, 기존 토큰도 지원
    async function isAdminSession(request, token) {
      const sid = getAdminCookie(request);
      if (sid && (await env.COUNTER_KV.get('admin_session:' + sid))) return true;
      if (token && (await env.COUNTER_KV.get('admin_token:' + token))) return true;
      return false;
    }

    // 토큰 유효성 검사 (하위 호환)
    async function isAdminToken(token) {
      if (!token) return false;
      return !!(await env.COUNTER_KV.get('admin_token:' + token));
    }

    // GET /posts?page=1&search= - 목록
    if (method === 'GET' && path === '/posts') {
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const pageSize = 10;
      const offset = (page - 1) * pageSize;
      const search = (url.searchParams.get('search') || '').trim();
      const searchType = url.searchParams.get('search_type') || 'both';
      const statusFilter = url.searchParams.get('status') || '';

      const conditions = [];
      const params = [];
      if (search) {
        const like = `%${search}%`;
        if (searchType === 'title') {
          conditions.push('p.title LIKE ?');
          params.push(like);
        } else if (searchType === 'content') {
          conditions.push('p.content LIKE ?');
          params.push(like);
        } else if (searchType === 'author') {
          conditions.push('p.name LIKE ?');
          params.push(like);
        } else {
          conditions.push('(p.title LIKE ? OR p.content LIKE ?)');
          params.push(like, like);
        }
      }
      if (FILTER_STATUSES.includes(statusFilter)) {
        // 표시 상태 계산: 알림(관리자 글) > 완료(관리자 답변) > 저장된 상태
        conditions.push(`CASE
          WHEN p.is_admin = 1 OR p.status = 'notice' THEN 'notice'
          WHEN (SELECT COUNT(*) FROM comments WHERE comments.post_id = p.id AND comments.is_admin = 1) > 0 THEN 'done'
          ELSE p.status END = ?`);
        params.push(statusFilter);
      }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

      const totalRow = await env.donian_board
        .prepare(`SELECT COUNT(*) as total FROM posts p ${where}`)
        .bind(...params)
        .first();
      const total = totalRow ? totalRow.total : 0;

      // 알림(관리자 글)은 항상 목록 최상단에 고정
      const rows = await env.donian_board
        .prepare(`SELECT p.id, p.name, p.title, p.created_at, p.views, p.is_locked, p.is_admin, p.status,
          (SELECT COUNT(*) FROM comments WHERE comments.post_id = p.id AND comments.is_admin = 1) as admin_replies,
          (SELECT COUNT(*) FROM comments WHERE comments.post_id = p.id) as comment_count
          FROM posts p ${where} ORDER BY p.is_admin DESC, p.created_at DESC LIMIT ? OFFSET ?`)
        .bind(...params, pageSize, offset)
        .all();

      return new Response(JSON.stringify({ total, page, pageSize, posts: rows.results || [] }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Credentials': 'true',
          'Cache-Control': 'public, max-age=30',
        },
      });
    }

    // GET /posts/:id - 상세보기 (조회수 증가)
    if (method === 'GET' && /^\/posts\/\d+$/.test(path)) {
      const id = parseInt(path.split('/')[2], 10);
      const post = await env.donian_board
        .prepare('SELECT id, name, title, content, created_at, views, is_locked, password_hash, is_admin, status FROM posts WHERE id = ?')
        .bind(id)
        .first();
      if (!post) return json({ error: 'not found' }, 404);

      if (post.is_locked) {
        const pw = url.searchParams.get('password') || '';
        if (!pw) return json({ error: 'locked', message: '비공개 게시글입니다. 비밀번호를 입력하세요.' }, 403);
        const hash = await hashPassword(pw);
        const adminHash = env.ADMIN_PASSWORD ? await hashPassword(env.ADMIN_PASSWORD) : null;
        const isAdmin = hash === adminHash;
        if (!isAdmin && (await isBlocked())) {
          return json({ error: '비밀번호를 3회 틀려 차단되었습니다. 내일 다시 시도하세요.' }, 429);
        }
        if (hash !== post.password_hash && !isAdmin) {
          const n = await recordFail();
          if (n >= 3) return json({ error: '비밀번호를 3회 틀려 차단되었습니다. 내일 다시 시도하세요.' }, 429);
          if (n >= 2) return json({ error: '비밀번호를 2회 틀렸습니다. 1회 더 틀리면 차단됩니다.' }, 403);
          return json({ error: 'wrong_password', message: '비밀번호가 일치하지 않습니다.' }, 403);
        }
      }

      // 조회수: IP당 24시간 1회 (D1 저장 → KV 안 씀)
      const DAY_MS = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      let views = post.views;
      const vr = await env.donian_board
        .prepare('SELECT viewed_at FROM post_views WHERE post_id = ? AND ip = ?')
        .bind(id, ip)
        .first();
      if (!vr || (nowMs - vr.viewed_at) > DAY_MS) {
        await env.donian_board.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
        await env.donian_board
          .prepare(`INSERT INTO post_views (post_id, ip, viewed_at) VALUES (?, ?, ?)
                    ON CONFLICT(post_id, ip) DO UPDATE SET viewed_at = excluded.viewed_at`)
          .bind(id, ip, nowMs)
          .run();
        views = post.views + 1;
      }
      const comments = await env.donian_board
        .prepare('SELECT id, name, content, created_at, password_hash, is_admin, parent_id FROM comments WHERE post_id = ? ORDER BY created_at ASC')
        .bind(id)
        .all();
      const enriched = (comments.results || []).map((c) => ({
        id: c.id,
        name: c.name,
        content: c.content,
        created_at: c.created_at,
        is_admin: c.is_admin,
        parent_id: c.parent_id,
        // 작성자 판별: 댓글 비밀번호 === 게시글 비밀번호 (이름 도용 방지)
        is_author: (!post.is_admin && c.password_hash && c.password_hash === post.password_hash),
      }));
      return json({
        post: {
          id: post.id,
          name: post.name,
          title: post.title,
          content: post.content,
          created_at: post.created_at,
          views: views,
          is_locked: post.is_locked,
          is_admin: post.is_admin,
          status: post.status,
        },
        comments: enriched,
      });
    }

    // PUT /posts/:id - 글 수정 (비밀번호 인증)
    if (method === 'PUT' && /^\/posts\/\d+$/.test(path)) {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const isAdmin = await isAdminSession(request, body.token);
      const { password, title, content, status } = body;
      if (!title || !content) return json({ error: '필수 항목 누락' }, 400);
      if (!isAdmin && !password) return json({ error: '비밀번호를 입력하세요.' }, 400);
      if (charLen(title) > 35) return json({ error: '제목은 35글자 이하여야 합니다.' }, 400);
      if (charLen(content) > 1500) return json({ error: '내용은 1500글자 이하여야 합니다.' }, 400);
      const spam = spamCheck(title + ' ' + content);
      if (spam) return json({ error: spam }, 400);
      if (hasProfanity(title + ' ' + content)) return json({ error: '욕설/비속어가 포함되어 등록할 수 없습니다.' }, 400);
      if (!(isAdmin || (await rateLimitWrite('edit', 5)))) return json({ error: '너무 많은 요청입니다. 잠시 후 시도하세요.' }, 429);
      const hash = password ? await hashPassword(password) : '';
      const adminHash = env.ADMIN_PASSWORD ? await hashPassword(env.ADMIN_PASSWORD) : null;
      const post = await env.donian_board.prepare('SELECT password_hash, status, is_admin FROM posts WHERE id = ?').bind(id).first();
      if (!post) return json({ error: 'not found' }, 404);
      if (!isAdmin && adminHash && hash === adminHash) {
        return json({ error: '관리자 비밀번호로 수정하려면 관리자 로그인이 필요합니다. 관리자 버튼으로 로그인하세요.' }, 403);
      }
      if (!isAdmin && post.password_hash !== hash) return json({ error: '비밀번호가 일치하지 않습니다.' }, 403);
      // 관리자 글은 항상 'notice' 유지, 일반 글은 허용값만 반영(없으면 기존값)
      const finalStatus = isAdmin || post.is_admin
        ? 'notice'
        : (POST_STATUSES.includes(status) ? status : (post.status || 'question'));
      await env.donian_board.prepare('UPDATE posts SET title = ?, content = ?, status = ? WHERE id = ?').bind(title, content, finalStatus, id).run();
      return json({ ok: true });
    }

    // POST /posts - 글쓰기
    if (method === 'POST' && path === '/posts') {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const { name, password, title, content, is_locked, status } = body;
      // 이름 사칭 검증을 봇 인증보다 먼저 (명확한 안내)
      const isAdmin = await isAdminSession(request, body.token);
      if (name && !isAdmin && isImpersonationName(name)) return json({ error: '관리자·운영자 또는 이와 혼동되는 이름은 사용할 수 없습니다.' }, 400);
      if (name && !isAdmin && hasProfanity(name)) return json({ error: '이름에 욕설/비속어가 포함되어 사용할 수 없습니다.' }, 400);
      if (!(await rateLimitEdge(ip, env))) return json({ error: '요청이 너무 많습니다. 잠시 후 시도하세요.' }, 429);
      const ts = await verifyTurnstile(body['cf-turnstile-response'], ip, env);
      if (!ts.success) return json({ error: '봇 인증에 실패했습니다.', detail: ts.errorCodes || [] }, 403);
      if (!password || !title || !content || !name) return json({ error: '이름, 비밀번호, 제목, 내용은 필수 항목입니다.' }, 400);
      if (!isAdmin && charLen(password) > 12) return json({ error: '비밀번호는 12글자 이하여야 합니다.' }, 400);
      if (name && charLen(name) > 27) return json({ error: '이름은 27글자 이하여야 합니다.' }, 400);
      if (charLen(title) > 35) return json({ error: '제목은 35글자 이하여야 합니다.' }, 400);
      if (charLen(content) > 1500) return json({ error: '내용은 1500글자 이하여야 합니다.' }, 400);
      if (content.trim().length < 1) return json({ error: '내용이 너무 짧습니다' }, 400);
      const spam = spamCheck(title + ' ' + content);
      if (spam) return json({ error: spam }, 400);
      if (hasProfanity(title + ' ' + content)) return json({ error: '욕설/비속어가 포함되어 등록할 수 없습니다.' }, 400);
      if (!(isAdmin || (await rateLimitWrite('post', 5)))) return json({ error: '게시글은 시간당 5회까지 작성할 수 있습니다.' }, 429);
      const hash = await hashPassword(password);
      const now = new Date().toISOString();
      const finalName = isAdmin ? 'Donian' : name;
      // 관리자 글은 자동 '알림', 일반 글은 문의/버그/의뢰만 허용
      const finalStatus = isAdmin ? 'notice' : (POST_STATUSES.includes(status) ? status : 'question');
      await env.donian_board
        .prepare('INSERT INTO posts (name, password_hash, title, content, created_at, is_locked, is_admin, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(finalName, hash, title, content, now, is_locked ? 1 : 0, isAdmin ? 1 : 0, finalStatus)
        .run();
      return json({ ok: true });
    }

    // DELETE /posts/:id - 글 삭제 (비밀번호)
    if (method === 'DELETE' && /^\/posts\/\d+$/.test(path)) {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      const hash = await hashPassword(body.password || '');
      const adminHash = env.ADMIN_PASSWORD ? await hashPassword(env.ADMIN_PASSWORD) : null;
      const post = await env.donian_board.prepare('SELECT password_hash FROM posts WHERE id = ?').bind(id).first();
      if (!post) return json({ error: 'not found' }, 404);
      const isAdmin = await isAdminSession(request, body.token);
      if (!isAdmin && adminHash && hash === adminHash) {
        return json({ error: '관리자 비밀번호로 삭제하려면 관리자 로그인이 필요합니다. 관리자 버튼으로 로그인하세요.' }, 403);
      }
      const isAuthor = post.password_hash === hash;
      if (!isAdmin) {
        if (await isBlocked()) return json({ error: '비밀번호를 3회 틀려 차단되었습니다. 내일 다시 시도하세요.' }, 429);
        if (!isAuthor) {
          const n = await recordFail();
          if (n >= 3) return json({ error: '비밀번호를 3회 틀려 차단되었습니다. 내일 다시 시도하세요.' }, 429);
          if (n >= 2) return json({ error: '비밀번호를 2회 틀렸습니다. 1회 더 틀리면 차단됩니다.' }, 403);
          return json({ error: '비밀번호가 일치하지 않습니다' }, 403);
        }
        // 관리자 답변이 달린(완료) 게시글은 관리자만 삭제 가능
        const adminComment = await env.donian_board
          .prepare('SELECT id FROM comments WHERE post_id = ? AND is_admin = 1 LIMIT 1')
          .bind(id)
          .first();
        if (adminComment) return json({ error: '관리자 답변이 달린 게시글은 관리자만 삭제할 수 있습니다.' }, 403);
      }
      await env.donian_board.prepare('DELETE FROM comments WHERE post_id = ?').bind(id).run();
      await env.donian_board.prepare('DELETE FROM post_views WHERE post_id = ?').bind(id).run();
      await env.donian_board.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // POST /posts/:id/comments - 댓글 작성
    if (method === 'POST' && /^\/posts\/\d+\/comments$/.test(path)) {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const { name, password, content, parent_id } = body;
      const isAdmin = await isAdminSession(request, body.token);
      if (name && !isAdmin && isImpersonationName(name)) return json({ error: '관리자·운영자 또는 이와 혼동되는 이름은 사용할 수 없습니다.' }, 400);
      if (name && !isAdmin && hasProfanity(name)) return json({ error: '이름에 욕설/비속어가 포함되어 사용할 수 없습니다.' }, 400);
      if (!(await rateLimitEdge(ip, env))) return json({ error: '요청이 너무 많습니다. 잠시 후 시도하세요.' }, 429);
      const ts = await verifyTurnstile(body['cf-turnstile-response'], ip, env);
      if (!ts.success) return json({ error: '봇 인증에 실패했습니다.', detail: ts.errorCodes || [] }, 403);
      if (!password || !content || !name) return json({ error: '이름, 비밀번호, 내용은 필수 항목입니다.' }, 400);
      if (charLen(password) > 12) return json({ error: '비밀번호는 12글자 이하여야 합니다.' }, 400);
      if (name && charLen(name) > 27) return json({ error: '이름은 27글자 이하여야 합니다.' }, 400);
      if (charLen(content) > 1500) return json({ error: '댓글은 1500글자 이하여야 합니다.' }, 400);
      if (content.trim().length < 1) return json({ error: '내용이 너무 짧습니다' }, 400);
      const spam = spamCheck(content);
      if (spam) return json({ error: spam }, 400);
      if (hasProfanity(content)) return json({ error: '욕설/비속어가 포함되어 등록할 수 없습니다.' }, 400);
      if (!(isAdmin || (await rateLimitWrite('comment', 20)))) return json({ error: '댓글은 시간당 20회까지 작성할 수 있습니다.' }, 429);
      const post = await env.donian_board.prepare('SELECT id, password_hash, is_admin FROM posts WHERE id = ?').bind(id).first();
      if (!post) return json({ error: 'not found' }, 404);
      let parentId = null;
      if (parent_id) {
        const parent = await env.donian_board
          .prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?')
          .bind(parent_id, id)
          .first();
        if (!parent) return json({ error: 'parent not found' }, 404);
        parentId = parent_id;
      }
      const hash = await hashPassword(password);
      // 관리자 게시글에 비관리자가 게시글 비번으로 댓글 → 사칭/해킹 → IP 차단
      if (!isAdmin && post.is_admin && post.password_hash && hash === post.password_hash) {
        await banIp();
        return json({ error: '해킹 및 불법봇사용으로 차단되었습니다.' }, 403);
      }
      const now = new Date().toISOString();
      const finalName = isAdmin ? 'Donian' : name;
      await env.donian_board
        .prepare('INSERT INTO comments (post_id, name, password_hash, content, created_at, is_admin, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, finalName, hash, content, now, isAdmin ? 1 : 0, parentId)
        .run();
      return json({ ok: true });
    }

    // DELETE /comments/:id - 댓글 삭제 (비밀번호)
    if (method === 'DELETE' && /^\/comments\/\d+$/.test(path)) {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      const hash = await hashPassword(body.password || '');
      const adminHash = env.ADMIN_PASSWORD ? await hashPassword(env.ADMIN_PASSWORD) : null;
      const comment = await env.donian_board.prepare('SELECT password_hash FROM comments WHERE id = ?').bind(id).first();
      if (!comment) return json({ error: 'not found' }, 404);
      const isAdmin = await isAdminSession(request, body.token);
      if (!isAdmin && adminHash && hash === adminHash) {
        return json({ error: '관리자 비밀번호로 댓글을 삭제하려면 관리자 로그인이 필요합니다. 관리자 버튼으로 로그인하세요.' }, 403);
      }
      if (!isAdmin) {
        if (await isBlocked()) return json({ error: '비밀번호를 3회 틀려 차단되었습니다. 내일 다시 시도하세요.' }, 429);
        if (comment.password_hash !== hash) {
          const n = await recordFail();
          if (n >= 3) return json({ error: '비밀번호를 3회 틀려 차단되었습니다. 내일 다시 시도하세요.' }, 429);
          if (n >= 2) return json({ error: '비밀번호를 2회 틀렸습니다. 1회 더 틀리면 차단됩니다.' }, 403);
          return json({ error: '비밀번호가 일치하지 않습니다' }, 403);
        }
      }
      // 답글이 달린 부모 댓글은 삭제 불가 (관리자 포함)
      const child = await env.donian_board
        .prepare('SELECT id FROM comments WHERE parent_id = ? LIMIT 1')
        .bind(id)
        .first();
      if (child) return json({ error: '답글이 달린 댓글은 삭제할 수 없습니다. 먼저 답글을 삭제하세요.' }, 403);
      await env.donian_board
        .prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM comments WHERE id = ?
          UNION ALL
          SELECT c.id FROM comments c JOIN descendants d ON c.parent_id = d.id
        )
        DELETE FROM comments WHERE id IN (SELECT id FROM descendants)`)
        .bind(id)
        .run();
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },

  // 매일 자동 정리 (Cron, 09:00 KST): 30일 지난 조회기록 / 만료된 카운터 삭제
  async scheduled(event, env) {
    const now = Date.now();
    const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;
    await env.donian_board.prepare('DELETE FROM post_views WHERE viewed_at < ?').bind(cutoff30d).run();
    await env.donian_board.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
  },
};