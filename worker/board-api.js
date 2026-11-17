// 게시판 API Worker (Cloudflare Workers + D1)
// 비회원제: 이름(선택) + 비밀번호(삭제용)

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

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

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';

    // IP당 시간당 10회 쓰기 제한
    async function rateLimit(action) {
      const key = `rl:${action}:${ip}`;
      const count = parseInt((await env.COUNTER_KV.get(key)) || '0', 10);
      if (count >= 10) return false;
      await env.COUNTER_KV.put(key, String(count + 1), { expirationTtl: 3600 });
      return true;
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
        .prepare(`SELECT id, name, title, created_at, views FROM posts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .bind(...params, pageSize, offset)
        .all();

      return json({ total, page, pageSize, posts: rows.results || [] });
    }

    // GET /posts/:id - 상세보기 (조회수 증가)
    if (method === 'GET' && /^\/posts\/\d+$/.test(path)) {
      const id = parseInt(path.split('/')[2], 10);
      await env.donian_board.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
      const post = await env.donian_board
        .prepare('SELECT id, name, title, content, created_at, views FROM posts WHERE id = ?')
        .bind(id)
        .first();
      if (!post) return json({ error: 'not found' }, 404);
      const comments = await env.donian_board
        .prepare('SELECT id, name, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC')
        .bind(id)
        .all();
      return json({ post, comments: comments.results || [] });
    }

    // POST /posts - 글쓰기
    if (method === 'POST' && path === '/posts') {
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const { name, password, title, content } = body;
      if (!password || !title || !content) return json({ error: '필수 항목 누락' }, 400);
      if (title.length > 200) return json({ error: '제목이 너무 깁니다' }, 400);
      if (content.length > 5000) return json({ error: '내용이 너무 깁니다' }, 400);
      if (!(await rateLimit('post'))) return json({ error: '너무 많은 요청입니다. 잠시 후 시도하세요.' }, 429);
      const hash = await hashPassword(password);
      const now = new Date().toISOString();
      await env.donian_board
        .prepare('INSERT INTO posts (name, password_hash, title, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(name || '익명', hash, title, content, now)
        .run();
      return json({ ok: true });
    }

    // DELETE /posts/:id - 글 삭제 (비밀번호)
    if (method === 'DELETE' && /^\/posts\/\d+$/.test(path)) {
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      const hash = await hashPassword(body.password || '');
      const post = await env.donian_board.prepare('SELECT password_hash FROM posts WHERE id = ?').bind(id).first();
      if (!post) return json({ error: 'not found' }, 404);
      if (post.password_hash !== hash) return json({ error: '비밀번호가 일치하지 않습니다' }, 403);
      await env.donian_board.prepare('DELETE FROM comments WHERE post_id = ?').bind(id).run();
      await env.donian_board.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // POST /posts/:id/comments - 댓글 작성
    if (method === 'POST' && /^\/posts\/\d+\/comments$/.test(path)) {
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      if (body.botcheck) return json({ error: 'bot' }, 400);
      const { name, password, content } = body;
      if (!password || !content) return json({ error: '필수 항목 누락' }, 400);
      if (content.length > 1000) return json({ error: '댓글이 너무 깁니다' }, 400);
      if (!(await rateLimit('comment'))) return json({ error: '너무 많은 요청입니다. 잠시 후 시도하세요.' }, 429);
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
      const id = parseInt(path.split('/')[2], 10);
      const body = await request.json();
      const hash = await hashPassword(body.password || '');
      const comment = await env.donian_board.prepare('SELECT password_hash FROM comments WHERE id = ?').bind(id).first();
      if (!comment) return json({ error: 'not found' }, 404);
      if (comment.password_hash !== hash) return json({ error: '비밀번호가 일치하지 않습니다' }, 403);
      await env.donian_board.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};