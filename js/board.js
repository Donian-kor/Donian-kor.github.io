// 게시판 모듈: 터미널 출력 영역에 목록/상세/작성/수정/댓글을 직접 렌더한다.
// board.html의 기존 API 로직을 모듈 인터페이스로 옮긴 것. worker는 변경하지 않는다.

const API_BASE = 'https://board-api.donian.workers.dev';
const TURNSTILE_SITE_KEY = '0x4AAAAAAGEuj5z4bjUhFlrp';

const STATUS_LABELS = { notice: '알림', done: '완료', question: '문의', bug: '버그', request: '의뢰' };

function genRandomPassword(len = 20) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[arr[i] % chars.length];
  return s;
}
function renderName(name, isAdmin) {
  if (isAdmin) return '<span class="badge-admin">Donian</span>';
  return esc(name || '익명');
}
function renderStatus(p) {
  let key, cls;
  if (p.is_admin || p.status === 'notice') { key = 'notice'; cls = 'st-notice'; }
  else if ((p.admin_replies || 0) > 0) { key = 'done'; cls = 'st-done'; }
  else { key = p.status || 'question'; cls = 'st-normal'; }
  return '<span class="' + cls + '">' + (STATUS_LABELS[key] || '문의') + '</span>';
}

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
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = [kst.getUTCFullYear(), String(kst.getUTCMonth() + 1).padStart(2, '0'), String(kst.getUTCDate()).padStart(2, '0')];
  const today = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')];
  if (day.join('.') === today.join('.')) {
    return String(kst.getUTCHours()).padStart(2, '0') + ':' + String(kst.getUTCMinutes()).padStart(2, '0');
  }
  return day.join('.');
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
  let searchType = 'both';
  let status = '';
  let currentPost = null;
  let turnstileWidget = null;

  const notify = msg => { if (onMessage) onMessage(msg); };

  function renderToolbar() {
    const statusOpts = [['', '기본'], ['notice', '알림'], ['question', '문의'], ['bug', '버그'], ['request', '의뢰'], ['done', '완료']];
    const typeOpts = [['both', '제목+내용'], ['title', '제목만'], ['content', '내용만'], ['author', '작성자만']];
    return '<div class="board-toolbar flex flex-row flex-wrap gap-1.5 mb-2">' +
      '<select class="board-select board-status" aria-label="상태 필터">' +
        statusOpts.map(([v, l]) => '<option value="' + v + '"' + (status === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select>' +
      '<select class="board-select board-search-type" aria-label="검색 대상">' +
        typeOpts.map(([v, l]) => '<option value="' + v + '"' + (searchType === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select>' +
      '<input class="board-search" type="text" placeholder="검색" value="' + esc(search) + '" aria-label="검색어">' +
      '<button type="button" class="filter-chip board-search-btn" aria-label="검색" title="검색"><iconify-icon icon="solar:magnifier-bold"></iconify-icon><span class="tool-btn-label">검색</span></button>' +
      '<button type="button" class="filter-chip board-reset-btn" aria-label="전체" title="전체"><iconify-icon icon="solar:refresh-bold"></iconify-icon><span class="tool-btn-label">전체</span></button>' +
      (isAdmin() ? '<span class="out-ok text-[.72em] ml-1">● 관리자</span>' : '') +
    '</div>';
  }

  function renderPagination(total) {
    const totalPages = Math.max(1, Math.ceil((total || 0) / 10));
    if (totalPages <= 1) return '';
    const prev = Math.max(1, page - 1), next = Math.min(totalPages, page + 1);
    let html = '<div class="board-pagination flex flex-wrap items-center justify-center gap-1 mt-2">';
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
      const params = new URLSearchParams({ page: String(page), _: String(Date.now()) });
      if (status) params.set('status', status);
      if (search) {
        params.set('search', search);
        params.set('search_type', searchType);
      }
      const data = await api('/posts?' + params.toString());
      const posts = Array.isArray(data.posts) ? data.posts : [];
      host.innerHTML = renderToolbar() +
        '<div class="board-list">' +
          '<div class="board-rows">' +
          '<div class="board-head"><span>분류</span><span>제목</span><span>작성자</span><span>작성일</span><span class="cat">조회</span></div>' +
            (posts.length ? posts.map(p =>
              '<button type="button" class="board-row-t" data-id="' + esc(p.id) + '">' +
                '<span class="st">' + renderStatus(p) + '</span>' +
                '<span class="name">' + (p.is_locked ? '🔒 ' : '') + esc(p.title) +
                  (p.comment_count > 0 ? ' <span class="out-ok">+' + p.comment_count + '</span>' : '') + '</span>' +
                '<span class="author">' + renderName(p.name, p.is_admin) + '</span>' +
                '<span class="date">' + fmtDate(p.created_at) + '</span>' +
                '<span class="cat">' + esc(p.views) + '</span>' +
              '</button>').join('') : '<div class="out-muted py-3">글이 없습니다.</div>') +
          '</div>' +
        '</div>' +
        '<div class="board-foot-row flex items-center justify-between gap-2 mt-2">' +
          renderPagination(data.total) +
          '<button type="button" class="board-write-btn shrink-0" data-action="write">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>글쓰기</button>' +
        '</div>';
      bindList();
    } catch (err) {
      host.innerHTML = '<div class="out-danger py-3">게시판 목록을 불러오지 못했습니다: ' + esc(err.message) + '</div>' +
        '<div class="out-muted">로컬에서는 API CORS로 막힐 수 있습니다. GitHub Pages에서 정상 동작합니다.</div>';
    }
  }

  function bindList() {
    host.querySelectorAll('.board-write-btn').forEach(btn => btn.addEventListener('click', () => renderWrite()));
    const doSearch = () => {
      const input = host.querySelector('.board-search');
      search = input ? input.value.trim() : '';
      page = 1;
      renderList();
    };
    const searchBtn = host.querySelector('.board-search-btn');
    if (searchBtn) searchBtn.addEventListener('click', doSearch);
    const resetBtn = host.querySelector('.board-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      status = ''; search = ''; searchType = 'both'; page = 1;
      renderList();
    });
    const statusSel = host.querySelector('.board-status');
    if (statusSel) statusSel.addEventListener('change', () => { status = statusSel.value; page = 1; renderList(); });
    const typeSel = host.querySelector('.board-search-type');
    if (typeSel) typeSel.addEventListener('change', () => { searchType = typeSel.value; });
    const input = host.querySelector('.board-search');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    host.querySelectorAll('.page-btn').forEach(btn => btn.addEventListener('click', () => {
      if (btn.disabled) return;
      page = parseInt(btn.dataset.page, 10) || 1;
      renderList();
    }));
    host.querySelectorAll('.board-row-t[data-id]').forEach(row => row.addEventListener('click', () => openDetail(row.dataset.id)));
  }

  function backBar(title) {
    return '<div class="flex items-center gap-2 mb-2">' +
      '<button type="button" class="filter-chip" data-action="back">← 목록</button>' +
      (title ? '<span class="out-head">' + esc(title) + '</span>' : '') + '</div>';
  }
  function bindBack() {
    const b = host.querySelector('[data-action="back"]');
    if (b) b.addEventListener('click', renderList);
  }

  async function openDetail(id, password) {
    host.innerHTML = '<div class="out-muted py-3">불러오는 중...</div>';
    try {
      const qs = '?_=' + Date.now() + (password ? '&password=' + encodeURIComponent(password) : '');
      const data = await api('/posts/' + encodeURIComponent(id) + qs);
      currentPost = data.post;
      renderDetail(data);
    } catch (err) {
      if (err.message === 'locked' || err.message === 'wrong_password') {
        host.innerHTML = backBar('비공개 글') +
          '<div class="out-amber py-2">작성자 또는 관리자 비밀번호가 필요합니다.</div>' +
          (err.message === 'wrong_password' ? '<div class="out-danger py-1">비밀번호가 일치하지 않습니다.</div>' : '') +
          '<form class="pw-form flex gap-1.5 mt-2"><input type="text" autocomplete="new-password" name="pw" class="board-input pw-mask" placeholder="비밀번호"><button class="filter-chip" type="submit">확인</button></form>';
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
    const ids = new Set(comments.map(c => c.id));
    const byId = new Map(comments.map(c => [c.id, c]));
    const childrenMap = {};
    const roots = [];
    for (const c of comments) {
      if (c.parent_id && ids.has(c.parent_id)) (childrenMap[c.parent_id] = childrenMap[c.parent_id] || []).push(c);
      else roots.push(c);
    }
    function node(c, depth) {
      const children = childrenMap[c.id] || [];
      const parent = c.parent_id ? byId.get(c.parent_id) : null;
      const replyTo = parent ? '<span class="reply-to">↳ @' + renderName(parent.name, parent.is_admin) + '</span>' : '';
      const authorBadge = (!c.is_admin && c.is_author) ? '<span class="badge-author">작성자</span>' : '';
      const indent = depth > 0 ? ' style="margin-left:1rem;border-left:1px solid var(--line-hi);padding-left:.5rem"' : '';
      return '<div class="comment-node" data-cid="' + c.id + '">' +
        '<div class="board-comment"' + indent + '>' +
          '<div class="flex items-center justify-between gap-2 mb-0.5">' +
            '<span>' + renderName(c.name, c.is_admin) + authorBadge + ' <span class="comment-date">· ' + fmtDate(c.created_at) + '</span></span>' +
            '<span class="comment-actions flex gap-2 shrink-0">' +
              '<button type="button" class="reply-comment filter-chip" data-cid="' + c.id + '">답글</button>' +
              '<button type="button" class="delete-comment filter-chip danger" data-cid="' + c.id + '"' + (children.length ? ' disabled title="답글이 달린 댓글은 삭제할 수 없습니다"' : '') + '>삭제</button>' +
            '</span>' +
          '</div>' +
          '<div class="out-dim keep-all">' + replyTo + nl2br(c.content) + '</div>' +
        '</div>' +
        (children.length ? '<div class="mt-1.5">' + children.map(ch => node(ch, depth + 1)).join('') + '</div>' : '') +
      '</div>';
    }
    return roots.map(r => node(r, 0)).join('');
  }

  function setMainFormVisible(visible) {
    const main = [...host.children].find(e => e.classList.contains('comment-form'));
    if (main) main.classList.toggle('hidden', !visible);
  }

  function showReplyForm(postId, commentId) {
    const node = host.querySelector('.comment-node[data-cid="' + commentId + '"]');
    if (!node) return;
    const existing = host.querySelector('.reply-form');
    if (existing && existing.dataset.cid === String(commentId)) {
      existing.remove();
      setMainFormVisible(true);
      return;
    }
    if (existing) existing.remove();
    setMainFormVisible(false);
    const form = document.createElement('form');
    form.className = 'comment-form reply-form mt-1.5';
    form.dataset.cid = String(commentId);
    form.innerHTML =
      '<div class="cf-ids">' +
        '<input class="board-input' + (isAdmin() ? ' admin-field' : '') + '" name="name" placeholder="이름" maxlength="27" value="' + (isAdmin() ? 'Donian' : '') + '" required>' +
        '<input class="board-input pw-mask" name="pw" type="text" autocomplete="new-password" placeholder="비밀번호" maxlength="12">' +
      '</div>' +
      '<textarea class="board-input" name="content" rows="2" maxlength="1500" placeholder="답글 내용" required></textarea>' +
      '<div class="cf-submit">' +
        '<button class="filter-chip" type="submit">답글 등록</button>' +
        '<div class="cf-turnstile"></div>' +
      '</div>';
    node.appendChild(form);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/posts/' + encodeURIComponent(postId) + '/comments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name') || '', password: fd.get('pw') || '', content: fd.get('content') || '',
            parent_id: Number(commentId), botcheck: fd.get('botcheck') || '',
            'cf-turnstile-response': fd.get('cf-turnstile-response') || '',
          }),
        });
        notify('답글이 등록되었습니다.');
        openDetail(postId);
      } catch (err) { notify('답글 등록 실패: ' + err.message); }
    });
    mountTurnstile(form);
    requestAnimationFrame(() => {
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const list = host.querySelector('.comment-list');
      if (list && list.scrollHeight > list.clientHeight) {
        list.scrollTop = list.scrollHeight;
      }
    });
  }

  async function removeComment(postId, commentId) {
    let body = {};
    if (!isAdmin()) {
      const pw = prompt('댓글 삭제 비밀번호를 입력하세요.');
      if (pw === null) return;
      body = { password: pw };
    }
    try {
      await api('/comments/' + encodeURIComponent(commentId), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      notify('댓글이 삭제되었습니다.');
      openDetail(postId);
    } catch (err) { notify('댓글 삭제 실패: ' + err.message); }
  }

  function renderDetail(data) {
    const p = data.post;
    const comments = Array.isArray(data.comments) ? data.comments : [];
    host.innerHTML =
      '<div class="post-head">' +
        '<div class="flex items-center gap-2 min-w-0">' +
          '<button type="button" class="filter-chip shrink-0" data-action="back">← 목록</button>' +
          renderStatus(p) +
          '<h3 id="modal-title" class="post-title">' + (p.is_locked ? '🔒 ' : '') + esc(p.title) + '</h3></div>' +
        '<div class="post-actions flex gap-1.5 shrink-0">' +
          '<button type="button" class="filter-chip" data-action="edit">수정</button>' +
          '<button type="button" class="filter-chip danger" data-action="delete">삭제</button>' +
        '</div>' +
      '</div>' +
      '<div class="post-meta">' + renderName(p.name, p.is_admin) + '<span class="post-date-group"> · <span class="post-date">' + fmtDate(p.created_at) + '</span></span> · 조회 ' + esc(p.views) + '</div>' +
      '<div class="post-body keep-all">' + nl2br(p.content) + '</div>' +
      '<form class="comment-form" autocomplete="off">' +
        '<div class="cf-ids">' +
          '<input class="board-input' + (isAdmin() ? ' admin-field' : '') + '" name="name" placeholder="이름" maxlength="27" value="' + (isAdmin() ? 'Donian' : '') + '" required>' +
          '<input class="board-input pw-mask" name="pw" type="text" autocomplete="new-password" placeholder="비밀번호" maxlength="12">' +
        '</div>' +
        '<textarea class="board-input" name="content" rows="2" maxlength="1500" placeholder="댓글 내용" required></textarea>' +
        '<div class="cf-submit">' +
          '<button class="filter-chip" type="submit">등록</button>' +
          '<div class="cf-turnstile"></div>' +
        '</div>' +
      '</form>' +
      '<div class="board-section">댓글 ' + comments.length + '</div>' +
      '<div class="comment-list">' + (comments.length ? renderCommentTree(comments) : '<div class="out-muted">댓글이 없습니다.</div>') + '</div>';
    bindBack();
    host.querySelector('[data-action="edit"]').addEventListener('click', () => renderEdit(p));
    host.querySelector('[data-action="delete"]').addEventListener('click', () => removePost(p.id));
    host.querySelectorAll('.reply-comment').forEach(btn => btn.addEventListener('click', () => showReplyForm(p.id, btn.dataset.cid)));
    host.querySelectorAll('.delete-comment').forEach(btn => btn.addEventListener('click', () => {
      if (!btn.disabled) removeComment(p.id, btn.dataset.cid);
    }));
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
    const admin = isAdmin();
    const nameVal = admin ? 'Donian' : (p && p.name || '');
    const pwAttrs = admin
      ? ' value="' + genRandomPassword(20) + '" readonly placeholder="관리자 (자동 생성)" class="board-input pw-mask admin-field"'
      : ' placeholder="비밀번호 (최대 12글자, 한글 불가)" maxlength="12" class="board-input pw-mask"';
    const statusField = admin
      ? '<input type="hidden" name="status" value="notice">'
      : '<select class="board-select" name="status">' +
          ['question', 'bug', 'request', 'notice'].map(v =>
            '<option value="' + v + '"' + ((p && p.status || 'question') === v ? ' selected' : '') + '>' + STATUS_LABELS[v] + '</option>').join('') +
        '</select>';
    return '<div class="flex gap-1.5"><input class="board-input' + (admin ? ' admin-field' : '') + '" name="name" placeholder="이름 (최대 27글자)" maxlength="27" value="' + esc(nameVal) + '" required>' +
      '<input name="pw" type="text" autocomplete="new-password" required' + pwAttrs + '></div>' +
      '<input class="board-input mt-1.5" name="title" placeholder="제목 (최대 35글자)" maxlength="35" value="' + esc(p && p.title || '') + '" required>' +
      '<textarea class="board-input mt-1.5" name="content" rows="8" maxlength="1500" placeholder="내용 (최대 1500글자)" required>' + esc(p && p.content || '') + '</textarea>' +
      '<div class="flex gap-1.5 mt-1.5">' + statusField +
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

  function show() { page = 1; search = ''; searchType = 'both'; status = ''; renderList(); }

  return { show, refresh: renderList };
}
