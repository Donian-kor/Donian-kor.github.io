// 게시판 모듈: 터미널 출력 영역에 목록/상세/작성/수정/댓글을 직접 렌더한다.
// board.html의 기존 API 로직을 모듈 인터페이스로 옮긴 것. worker는 변경하지 않는다.

const API_BASE = 'https://board-api.donian.workers.dev';
const TURNSTILE_SITE_KEY = '0x4AAAAAAGEuj5z4bjUhFlrp';

const STATUS_LABEL = { notice: '공지', question: '문의', bug: '버그', request: '요청', done: '완료' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
}
function isAdmin() { return !!sessionStorage.getItem('board_admin_token'); }

async function api(path, options) {
  const opts = { credentials: 'include', ...(options || {}) };
  if (opts.body && typeof opts.body === 'string' && opts.method && opts.method !== 'GET') {
    try {
      const obj = JSON.parse(opts.body);
      const token = sessionStorage.getItem('board_admin_token');
      if (token && obj.token === undefined) obj.token = token;
      opts.body = JSON.stringify(obj);
    } catch (e) { /* ignore */ }
  }
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || ('HTTP ' + res.status));
    err.data = data;
    throw err;
  }
  return data;
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector('script[data-od-turnstile]');
  if (existing) {
    return new Promise(resolve => {
      if (window.turnstile) return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
    });
  }
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.setAttribute('data-od-turnstile', '1');
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

export function createBoard({ host, onMessage }) {
  let page = 1;
  let search = '';
  let status = '';
  let currentPost = null;
  let turnstileWidget = null;

  const notify = msg => { if (onMessage) onMessage(msg); };

  function renderToolbar() {
    return '<div class="flex flex-wrap items-center gap-1.5 mb-2">' +
      '<button type="button" class="filter-chip" data-action="write">✎ 글쓰기</button>' +
      '<select class="board-select" aria-label="상태 필터">' +
        ['', 'notice', 'question', 'bug', 'request', 'done'].map(v =>
          '<option value="' + v + '"' + (status === v ? ' selected' : '') + '>' + (v ? STATUS_LABEL[v] : '전체 상태') + '</option>').join('') +
      '</select>' +
      '<input class="board-search" type="text" placeholder="검색어" value="' + esc(search) + '" aria-label="검색어">' +
      '<button type="button" class="filter-chip" data-action="search">검색</button>' +
      (isAdmin() ? '<span class="out-ok text-[.72em] ml-1">● 관리자</span>' : '') +
    '</div>';
  }

  function renderPagination(total) {
    const totalPages = Math.max(1, Math.ceil((total || 0) / 10));
    if (totalPages <= 1) return '';
    const prev = Math.max(1, page - 1), next = Math.min(totalPages, page + 1);
    let html = '<div class="flex flex-wrap items-center gap-1 mt-2">';
    html += '<button type="button" class="page-btn" data-page="' + prev + '"' + (page === 1 ? ' disabled' : '') + '>이전</button>';
    for (let i = 1; i <= totalPages; i++) {
      html += '<button type="button" class="page-btn' + (i === page ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }
    html += '<button type="button" class="page-btn" data-page="' + next + '"' + (page === totalPages ? ' disabled' : '') + '>다음</button>';
    return html + '</div>';
  }

  async function renderList() {
    host.innerHTML = '<div class="out-muted py-3">불러오는 중...</div>';
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      const data = await api('/posts?' + params.toString());
      const posts = Array.isArray(data.posts) ? data.posts : [];
      host.innerHTML = renderToolbar() +
        '<div class="out-muted mb-1">총 ' + (data.total || 0) + '건 • ' + page + ' / ' + Math.max(1, Math.ceil((data.total || 0) / 10)) + ' 페이지 • 행 클릭 시 상세</div>' +
        '<div class="proj-head"><span>작성일</span><span>제목</span><span class="cat">작성자 / 조회</span></div>' +
        (posts.length ? posts.map(p =>
          '<button type="button" class="proj-row" data-id="' + esc(p.id) + '">' +
            '<span class="date">' + fmtDate(p.created_at) + '</span>' +
            '<span class="name">' + (p.is_locked ? '🔒 ' : '') + esc(p.title) +
              (p.comment_count > 0 ? ' <span class="out-ok">+' + p.comment_count + '</span>' : '') + '</span>' +
            '<span class="cat">' + esc(p.name) + (p.is_admin ? ' ★' : '') + ' / ' + esc(p.views) + '</span>' +
          '</button>').join('') : '<div class="out-muted py-3">글이 없습니다.</div>') +
        renderPagination(data.total);
      bindList();
    } catch (err) {
      host.innerHTML = '<div class="out-danger py-3">게시판 목록을 불러오지 못했습니다: ' + esc(err.message) + '</div>' +
        '<div class="out-muted">로컬에서는 API CORS로 막힐 수 있습니다. GitHub Pages에서 정상 동작합니다.</div>';
    }
  }

  function bindList() {
    host.querySelectorAll('.filter-chip').forEach(btn => btn.addEventListener('click', () => {
      const a = btn.dataset.action;
      if (a === 'write') return renderWrite();
      if (a === 'search') {
        const input = host.querySelector('.board-search');
        search = input ? input.value.trim() : '';
        page = 1;
        renderList();
      }
    }));
    const sel = host.querySelector('.board-select');
    if (sel) sel.addEventListener('change', () => { status = sel.value; page = 1; renderList(); });
    const input = host.querySelector('.board-search');
    if (input) input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { search = input.value.trim(); page = 1; renderList(); }
    });
    host.querySelectorAll('.page-btn').forEach(btn => btn.addEventListener('click', () => {
      if (btn.disabled) return;
      page = parseInt(btn.dataset.page, 10) || 1;
      renderList();
    }));
    host.querySelectorAll('.proj-row[data-id]').forEach(row => row.addEventListener('click', () => openDetail(row.dataset.id)));
  }

  function backBar(title) {
    return '<div class="flex items-center gap-2 mb-2">' +
      '<button type="button" class="filter-chip" data-action="back">← 목록</button>' +
      '<span class="out-head">' + esc(title) + '</span></div>';
  }
  function bindBack() {
    const b = host.querySelector('[data-action="back"]');
    if (b) b.addEventListener('click', renderList);
  }

  async function openDetail(id, password) {
    host.innerHTML = '<div class="out-muted py-3">불러오는 중...</div>';
    try {
      const qs = password ? '?password=' + encodeURIComponent(password) : '';
      const data = await api('/posts/' + encodeURIComponent(id) + qs);
      currentPost = data.post;
      renderDetail(data);
    } catch (err) {
      if (err.message === 'locked' || err.message === 'wrong_password') {
        host.innerHTML = backBar('비공개 글') +
          '<div class="out-amber py-2">작성자 또는 관리자 비밀번호가 필요합니다.</div>' +
          (err.message === 'wrong_password' ? '<div class="out-danger py-1">비밀번호가 일치하지 않습니다.</div>' : '') +
          '<form class="pw-form flex gap-1.5 mt-2"><input type="password" name="pw" class="board-input" placeholder="비밀번호"><button class="filter-chip" type="submit">확인</button></form>';
        bindBack();
        host.querySelector('.pw-form').addEventListener('submit', e => {
          e.preventDefault();
          openDetail(id, new FormData(e.target).get('pw') || '');
        });
      } else {
        host.innerHTML = '<div class="out-danger py-3">불러오기 실패: ' + esc(err.message) + '</div>';
      }
    }
  }

  function renderCommentTree(comments) {
    return comments.map(c =>
      '<div class="board-comment" style="margin-left:' + Math.min(Number(c.depth || 0) * 12, 60) + 'px">' +
        '<div class="text-zinc-200 text-sm">' + esc(c.name) + (c.is_admin ? ' ★' : '') + '</div>' +
        '<div class="out-dim keep-all">' + nl2br(c.content) + '</div>' +
      '</div>').join('');
  }

  function renderDetail(data) {
    const p = data.post;
    const comments = Array.isArray(data.comments) ? data.comments : [];
    host.innerHTML = backBar(STATUS_LABEL[p.status] || p.status || '글') +
      '<div class="out-head text-[1.05em] mb-1">' + (p.is_locked ? '🔒 ' : '') + esc(p.title) + '</div>' +
      '<div class="out-muted mb-2">' + esc(p.name) + (p.is_admin ? ' ★' : '') + ' · ' + fmtDate(p.created_at) + ' · 조회 ' + esc(p.views) + '</div>' +
      '<div class="out-dim keep-all mb-3">' + nl2br(p.content) + '</div>' +
      '<div class="flex gap-1.5 mb-3">' +
        '<button type="button" class="filter-chip" data-action="edit">수정</button>' +
        '<button type="button" class="filter-chip danger" data-action="delete">삭제</button>' +
      '</div>' +
      '<div class="board-section">댓글 ' + comments.length + '</div>' +
      (comments.length ? renderCommentTree(comments) : '<div class="out-muted">댓글이 없습니다.</div>') +
      '<form class="comment-form mt-2" autocomplete="off">' +
        '<div class="flex gap-1.5"><input class="board-input" name="name" placeholder="이름" maxlength="27" required>' +
        '<input class="board-input" name="pw" type="password" placeholder="비밀번호" maxlength="12"></div>' +
        '<textarea class="board-input mt-1.5" name="content" rows="3" maxlength="1500" placeholder="댓글 내용" required></textarea>' +
        '<div class="cf-turnstile mt-1.5"></div>' +
        '<button class="filter-chip mt-1.5" type="submit">댓글 등록</button>' +
      '</form>';
    bindBack();
    host.querySelector('[data-action="edit"]').addEventListener('click', () => renderEdit(p));
    host.querySelector('[data-action="delete"]').addEventListener('click', () => removePost(p.id));
    const form = host.querySelector('.comment-form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/posts/' + encodeURIComponent(p.id) + '/comments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name') || '', password: fd.get('pw') || '', content: fd.get('content') || '',
            botcheck: fd.get('botcheck') || '', 'cf-turnstile-response': fd.get('cf-turnstile-response') || '',
          }),
        });
        notify('댓글이 등록되었습니다.');
        openDetail(p.id);
      } catch (err) { notify('댓글 등록 실패: ' + err.message); }
    });
    mountTurnstile(host);
  }

  function formFields(p, isEdit) {
    return '<div class="flex gap-1.5"><input class="board-input" name="name" placeholder="이름 (최대 27글자)" maxlength="27" value="' + esc(p && p.name || '') + '"' + (isAdmin() ? ' readonly' : '') + ' required>' +
      '<input class="board-input" name="pw" type="password" placeholder="비밀번호" maxlength="12"' + (isAdmin() ? ' disabled' : '') + '></div>' +
      '<input class="board-input mt-1.5" name="title" placeholder="제목 (최대 35글자)" maxlength="35" value="' + esc(p && p.title || '') + '" required>' +
      '<textarea class="board-input mt-1.5" name="content" rows="8" maxlength="1500" placeholder="내용 (최대 1500글자)" required>' + esc(p && p.content || '') + '</textarea>' +
      '<div class="flex gap-1.5 mt-1.5"><select class="board-select" name="status">' +
        ['question', 'bug', 'request', 'notice'].map(v =>
          '<option value="' + v + '"' + ((p && p.status || 'question') === v ? ' selected' : '') + '>' + STATUS_LABEL[v] + '</option>').join('') +
      '</select>' +
      '<label class="out-dim text-[.78em] flex items-center gap-1"><input type="checkbox" name="is_locked"' + (p && p.is_locked ? ' checked' : '') + '> 비공개</label></div>' +
      '<input type="hidden" name="botcheck" value="">' +
      '<div class="cf-turnstile mt-1.5"></div>';
  }

  function renderWrite() {
    host.innerHTML = backBar('글쓰기') +
      '<form class="board-form">' + formFields(null, false) +
      '<button class="filter-chip mt-2" type="submit">등록</button></form>';
    bindBack();
    const form = host.querySelector('.board-form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/posts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name') || '', password: fd.get('pw') || '', title: fd.get('title') || '',
            content: fd.get('content') || '', status: fd.get('status') || 'question',
            is_locked: fd.get('is_locked') ? 1 : 0, botcheck: fd.get('botcheck') || '',
            'cf-turnstile-response': fd.get('cf-turnstile-response') || '',
          }),
        });
        notify('글이 등록되었습니다.');
        page = 1;
        renderList();
      } catch (err) { notify('글 등록 실패: ' + err.message); }
    });
    mountTurnstile(host);
  }

  function renderEdit(p) {
    host.innerHTML = backBar('글 수정') +
      '<form class="board-form">' + formFields(p, true) +
      '<button class="filter-chip mt-2" type="submit">수정 완료</button></form>';
    bindBack();
    const form = host.querySelector('.board-form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/posts/' + encodeURIComponent(p.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: fd.get('pw') || '', title: fd.get('title') || '', content: fd.get('content') || '',
            status: fd.get('status') || 'question', botcheck: fd.get('botcheck') || '',
          }),
        });
        notify('글이 수정되었습니다.');
        openDetail(p.id);
      } catch (err) { notify('글 수정 실패: ' + err.message); }
    });
    mountTurnstile(host);
  }

  async function removePost(id) {
    let body = {};
    if (!isAdmin()) {
      const pw = prompt('글 삭제 비밀번호를 입력하세요.');
      if (pw === null) return;
      body = { password: pw };
    }
    try {
      await api('/posts/' + encodeURIComponent(id), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      notify('글이 삭제되었습니다.');
      renderList();
    } catch (err) { notify('글 삭제 실패: ' + err.message); }
  }

  function mountTurnstile(scope) {
    if (!TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY.indexOf('YOUR') !== -1) return;
    loadTurnstile().then(() => {
      if (!window.turnstile) return;
      scope.querySelectorAll('.cf-turnstile').forEach(el => {
        if (el.dataset.rendered) return;
        el.dataset.rendered = '1';
        turnstileWidget = window.turnstile.render(el, { sitekey: TURNSTILE_SITE_KEY, theme: 'dark' });
      });
    });
  }

  function show() { page = 1; search = ''; status = ''; renderList(); }

  return { show, refresh: renderList };
}
