// 게시판 API Worker (Cloudflare Workers + D1)
// 비회원제: 이름(선택) + 비밀번호(삭제용)
// 잠금(비공개): 작성자 또는 관리자만 열람 가능
// 보안: 봇/크롤러 차단, IP 레이트리밋, 스팸 필터

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

// 욕설/비속어 목록 (프론트 하이라이팅용 /profanity-list, 서버 차단용)
import PROFANITY_RAW from './profanity-words.js';
const PROFANITY = PROFANITY_RAW.split('\n').filter(Boolean);

function normalizeText(s) {
  return String(s).toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

const PROFANITY_NORM = PROFANITY.map((w) => normalizeText(w)).filter(Boolean);

function hasProfanity(text) {
  const n = normalizeText(text);
  return PROFANITY_NORM.some((w) => n.includes(w));
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
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ua = request.headers.get('user-agent') || '';

    // IP당 쓰기 제한: 시간당 N회
    async function rateLimitWrite(action, limit) {
      const key = `rl:w:${action}:${ip}`;
      const count = parseInt((await env.COUNTER_KV.get(key)) || '0', 10);
      if (count >= limit) return false;
      await env.COUNTER_KV.put(key, String(count + 1), { expirationTtl: 3600 });
      return true;
    }

    // IP당 읽기 제한: 분당 60회 (스크래핑 방지)
    async function rateLimitRead() {
      const key = `rl:r:${ip}`;
      const count = parseInt((await env.COUNTER_KV.get(key)) || '0', 10);
      if (count >= 60) return false;
      await env.COUNTER_KV.put(key, String(count + 1), { expirationTtl: 60 });
      return true;
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
      return json({ words: PROFANITY });
    }

    // POST /admin/verify - 관리자 비밀번호 확인 (본문으로 전송, URL 노출 방지)
    if (method === 'POST' && path === '/admin/verify') {
      const body = await request.json().catch(() => ({}));
      const pw = body.password || '';
      return json({ ok: !!(env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD) });
    }

    // GET /posts?page=1&search= - 목록
    if (method === 'GET' && path === '/posts') {
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const pageSize = 10;
      const offset = (page - 1) * pageSize;
      const search = (url.searchParams.get('search') || '').trim();

      let where = '';
      let params = [];
      if (search) {
        where = 'WHERE title LIKE ? OR content LIKE ?';
        params = [`%${search}%`, `%${search}%`];
      }

      const totalRow = await env.donian_board
        .prepare(`SELECT COUNT(*) as total FROM posts ${where}`)
        .bind(...params)
        .first();
      const total = totalRow ? totalRow.total : 0;

      const rows = await env.donian_board
        .prepare(`SELECT id, name, title, created_at, views, is_locked FROM posts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .bind(...params, pageSize, offset)
        .all();

      return json({ total, page, pageSize, posts: rows.results || [] });
    }

    // GET /posts/:id - 상세보기 (조회수 증가)
    if (method === 'GET' && /^\/posts\/\d+$/.test(path)) {
      const id = parseInt(path.split('/')[2], 10);
      const post = await env.donian_board
        .prepare('SELECT id, name, title, content, created_at, views, is_locked, password_hash FROM posts WHERE id = ?')
        .bind(id)
        .first();
      if (!post) return json({ error: 'not found' }, 404);

      if (post.is_locked) {
        const pw = url.searchParams.get('password') || '';
        if (!pw) return json({ error: 'locked', message: '비공개 게시글입니다. 비밀번호를 입력하세요.' }, 403);
        const hash = await hashPassword(pw);
        const adminHash = env.ADMIN_PASSWORD ? await hashPassword(env.ADMIN_PASSWORD) : null;
        if (hash !== post.password_hash && hash !== adminHash) {
          return json({ error: 'wrong_password', message: '비밀번호가 일치하지 않습니다.' }, 403);
        }
      }

      await env.donian_board.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
      const comments = await env.donian_board
        .prepare('SELECT id, name, content, created_at, password_hash FROM comments WHERE post_id = ? ORDER BY created_at ASC')
        .bind(id)
        .all();
      const anon = (n) => !n || n === '익명';
      const authorName = anon(post.name) ? null : post.name;
      const enriched = (comments.results || []).map((c) => ({
        id: c.id,
        name: c.name,
        content: c.content,
        created_at: c.created_at,
        is_author: (authorName !== null && !anon(c.name) && c.name === authorName)
          || (c.password_hash && c.password_hash === post.password_hash),
      }));
      return json({
        post: {
          id: post.id,
          name: post.name,
          title: post.title,
          content: post.content,
          created_at: post.created_at,
          views: post.views + 1,
          is_locked: post.is_locked,
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
      const isAdmin = !!(body.admin_pw && env.ADMIN_PASSWORD && body.admin_pw === env.ADMIN_PASSWORD);
      const { password, title, content } = body;
      if (!password || !title || !content) return json({ error: '필수 항목 누락' }, 400);
      if (charLen(title) > 20) return json({ error: '제목은 20글자 이하여야 합니다.' }, 400);
      if (charLen(content) > 500) return json({ error: '내용은 500글자 이하여야 합니다.' }, 400);
      const spam = spamCheck(title + ' ' + content);
      if (spam) return json({ error: spam }, 400);
      if (hasProfanity(title + ' ' + content)) return json({ error: '욕설/비속어가 포함되어 등록할 수 없습니다.' }, 400);
      if (!(isAdmin || (await rateLimitWrite('edit', 10)))) return json({ error: '너무 많은 요청입니다. 잠시 후 시도하세요.' }, 429);
      const hash = await hashPassword(password);
      const adminHash = env.ADMIN_PASSWORD ? await hashPassword(env.ADMIN_PASSWORD) : null;
      const post = await env.donian_board.prepare('SELECT password_hash FROM posts WHERE id = ?').bind(id).first();
      if (!post) return json({ error: 'not found' }, 404);
      if (post.password_hash !== hash && hash !== adminHash) return json({ error: '비밀번호가 일치하지 않습니다.' }, 403);
      await env.donian_board.prepare('UPDATE posts SET title = ?, content = ? WHERE id = ?').bind(title, content, id).run();
      return json({ ok: true });
    }

    // POST /posts - 글쓰기
    if (method === 'POST' && path === '/posts') {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const isAdmin = !!(body.admin_pw && env.ADMIN_PASSWORD && body.admin_pw === env.ADMIN_PASSWORD);
      const { name, password, title, content, is_locked } = body;
      if (!password || !title || !content) return json({ error: '필수 항목 누락' }, 400);
      if (charLen(password) < 2) return json({ error: '비밀번호는 2글자 이상이어야 합니다.' }, 400);
      if (charLen(password) > 8) return json({ error: '비밀번호는 8글자 이하여야 합니다.' }, 400);
      if (name && charLen(name.trim()) === 1) return json({ error: '이름은 2글자 이상이어야 합니다.' }, 400);
      if (name && charLen(name) > 10) return json({ error: '이름은 10글자 이하여야 합니다.' }, 400);
      if (charLen(title) > 20) return json({ error: '제목은 20글자 이하여야 합니다.' }, 400);
      if (charLen(content) > 500) return json({ error: '내용은 500글자 이하여야 합니다.' }, 400);
      if (content.trim().length < 1) return json({ error: '내용이 너무 짧습니다' }, 400);
      const spam = spamCheck(title + ' ' + content);
      if (spam) return json({ error: spam }, 400);
      if (hasProfanity(title + ' ' + content)) return json({ error: '욕설/비속어가 포함되어 등록할 수 없습니다.' }, 400);
      if (!(isAdmin || (await rateLimitWrite('post', 3)))) return json({ error: '게시글은 시간당 3회까지 작성할 수 있습니다.' }, 429);
      const hash = await hashPassword(password);
      const now = new Date().toISOString();
      await env.donian_board
        .prepare('INSERT INTO posts (name, password_hash, title, content, created_at, is_locked) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(name || '익명', hash, title, content, now, is_locked ? 1 : 0)
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
      if (post.password_hash !== hash && hash !== adminHash) return json({ error: '비밀번호가 일치하지 않습니다' }, 403);
      await env.donian_board.prepare('DELETE FROM comments WHERE post_id = ?').bind(id).run();
      await env.donian_board.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // POST /posts/:id/comments - 댓글 작성
    if (method === 'POST' && /^\/posts\/\d+\/comments$/.test(path)) {
      if (isBot(ua)) return json({ error: '봇 요청은 차단됩니다.' }, 403);
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const isAdmin = !!(body.admin_pw && env.ADMIN_PASSWORD && body.admin_pw === env.ADMIN_PASSWORD);
      const { name, password, content } = body;
      if (!password || !content) return json({ error: '필수 항목 누락' }, 400);
      if (charLen(password) < 2) return json({ error: '비밀번호는 2글자 이상이어야 합니다.' }, 400);
      if (charLen(password) > 8) return json({ error: '비밀번호는 8글자 이하여야 합니다.' }, 400);
      if (name && charLen(name.trim()) === 1) return json({ error: '이름은 2글자 이상이어야 합니다.' }, 400);
      if (name && charLen(name) > 10) return json({ error: '이름은 10글자 이하여야 합니다.' }, 400);
      if (charLen(content) > 50) return json({ error: '댓글은 50글자 이하여야 합니다.' }, 400);
      if (content.trim().length < 1) return json({ error: '내용이 너무 짧습니다' }, 400);
      const spam = spamCheck(content);
      if (spam) return json({ error: spam }, 400);
      if (hasProfanity(content)) return json({ error: '욕설/비속어가 포함되어 등록할 수 없습니다.' }, 400);
      if (!(isAdmin || (await rateLimitWrite('comment', 5)))) return json({ error: '댓글은 시간당 5회까지 작성할 수 있습니다.' }, 429);
      const post = await env.donian_board.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first();
      if (!post) return json({ error: 'not found' }, 404);
      const hash = await hashPassword(password);
      const now = new Date().toISOString();
      await env.donian_board
        .prepare('INSERT INTO comments (post_id, name, password_hash, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, name || '익명', hash, content, now)
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
      if (comment.password_hash !== hash && hash !== adminHash) return json({ error: '비밀번호가 일치하지 않습니다' }, 403);
      await env.donian_board.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};