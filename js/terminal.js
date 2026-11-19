// 터미널 명령 모듈: 명령 registry, 타이핑 출력, help, 보안 검증, 숨겨진 관리자 명령.
// index.html의 initTerminal(ctx) 호출로 초기화한다.

const ADMIN_CMD = '관리자';
const ADMIN_API = 'https://board-api.donian.workers.dev';

const ALLOWED_VERBS = new Set([
  'whoami', 'get-history', 'history', 'help', '?', 'get-childitem', 'ls', 'dir',
  'get-content', 'cat', 'type', 'music', 'contact', 'clear', 'cls', ADMIN_CMD,
]);
const SAFE_ARG = /^[\w가-힣.\-\\]{1,80}$/u;

const CAREER = [
  ['2026.11.19', 'YouTube-Ad-Blocker 공개', '크롬 광고차단 확장프로그램'],
  ['2026.11.12', 'MyAITutor 개발 중', 'AI 튜터 프로젝트'],
  ['2026.11.06', 'pdf_hwp_viewer 공개', 'PDF/HWP 뷰어'],
  ['2026.10.21', 'AI_GoStop 공개', 'AI 고스톱'],
  ['2026.10.20', 'AI_jjangie 공개', 'AI 웹앱'],
  ['2026.09.25', 'gpu-cpu-status-monitor 공개', 'GPU/CPU 모니터링'],
  ['2026.09.12', 'Novel_Studio_Maker 공개', '소설 제작 보조'],
  ['2026.06.02', 'split-text-file 공개', '텍스트 분할 도구'],
  ['2026.01.07', 'AI coding 개발 입문', ''],
  ['2007.09.12', '만기제대', ''],
  ['2005.09.13', '육군입대', ''],
  ['2000. 4월경', '유니텔 자료실 "메모장 프로그램 출시"', ''],
  ['1999. 4월경', '"창조98" 입문', ''],
  ['1998. 2월경', 'Visual Basic 입문', ''],
];

function parseCommand(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (s.length > 120) return null;
  const m = s.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { verb: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}
export function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
export function safeUrl(u, allowRelative) {
  const s = String(u || '').trim();
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  if (allowRelative && /^assets\/[A-Za-z0-9._\-\/]+\.(webp|png|jpe?g|gif|svg)$/i.test(s)) return s;
  return '';
}

export function initTerminal(ctx) {
  const { out, streamHost, musicInline, input } = ctx;
  let typeToken = 0;
  let pendingAdminPw = false;
  let boardHost = null;
  let board = null;

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function typeLine(text, cls, token, speed) {
    speed = speed || 9;
    const div = document.createElement('div');
    div.className = 'out-line ' + (cls || 'out-dim');
    streamHost.appendChild(div);
    const cur = document.createElement('span');
    cur.className = 'term-cursor';
    div.appendChild(cur);
    for (let i = 0; i < text.length; i++) {
      if (token !== typeToken) return;
      div.insertBefore(document.createTextNode(text[i]), cur);
      out.scrollTop = out.scrollHeight;
      if (i % 3 === 0) await wait(speed);
    }
    cur.remove();
    out.scrollTop = out.scrollHeight;
  }

  async function typeHtmlEcho(cmd, token) {
    const div = document.createElement('div');
    div.className = 'out-line cmd-echo';
    div.innerHTML = '<span class="pn">PS C:\\Donian\\Portfolio&gt;</span> <span class="echo-text"></span>';
    streamHost.appendChild(div);
    const target = div.querySelector('.echo-text');
    for (let i = 0; i < cmd.length; i++) {
      if (token !== typeToken) return;
      target.textContent += cmd[i];
      out.scrollTop = out.scrollHeight;
      await wait(9);
    }
  }

  async function typeHelpLine(cmd, desc, color, token) {
    const div = document.createElement('div');
    div.className = 'out-line help-line';
    div.innerHTML = '<span class="help-mark">●</span> <span class="help-cmd"></span><span class="help-desc"></span>';
    div.querySelector('.help-mark').style.color = color;
    streamHost.appendChild(div);
    const cmdEl = div.querySelector('.help-cmd');
    for (let i = 0; i < cmd.length; i++) {
      if (token !== typeToken) return;
      cmdEl.textContent += cmd[i];
      out.scrollTop = out.scrollHeight;
      await wait(6);
    }
    div.querySelector('.help-desc').textContent = '  ' + desc;
    out.scrollTop = out.scrollHeight;
  }

  function addStaticLine(text, cls) {
    const div = document.createElement('div');
    div.className = 'out-line ' + (cls || 'out-dim');
    div.textContent = text;
    streamHost.appendChild(div);
    out.scrollTop = out.scrollHeight;
    return div;
  }

  function clearOutput() {
    typeToken++;
    streamHost.innerHTML = '';
    musicInline.classList.add('hidden');
    if (boardHost) { boardHost.innerHTML = ''; boardHost.classList.add('hidden'); }
    if (input) input.value = '';
  }

  async function deny(reason, token) {
    await typeLine('⛔ 접근금지: 허용되지 않은 명령입니다.', 'out-danger', token);
    if (reason) await typeLine('   ' + reason, 'out-muted', token);
  }

  async function adminVerify(password, token) {
    if (!password) { await typeLine('비밀번호가 입력되지 않았습니다.', 'out-amber', token); return; }
    try {
      const res = await fetch(ADMIN_API + '/admin/verify', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.token) {
        sessionStorage.setItem('board_admin_token', data.token);
        await typeLine('✓ 관리자 모드가 활성화되었습니다.', 'out-ok', token);
      } else {
        await typeLine('✕ ' + (data.error || '비밀번호가 일치하지 않습니다.'), 'out-danger', token);
      }
    } catch (e) {
      await typeLine('✕ 확인 실패: ' + e.message, 'out-danger', token);
    }
  }

  async function ensureBoard() {
    if (board) return board;
    if (!boardHost) {
      boardHost = document.createElement('div');
      boardHost.id = 'board-host';
      boardHost.className = 'board-host hidden';
      out.parentElement.insertBefore(boardHost, out.nextSibling);
    }
    const mod = await import('./board.js');
    board = mod.createBoard({
      host: boardHost,
      onMessage: msg => addStaticLine('• ' + msg, 'out-ok'),
    });
    return board;
  }

  function showHelp(token) {
    return (async () => {
      await typeLine('◆ 사용 가능한 명령', 'out-head', token);
      const EM = 'var(--emerald)', AM = 'var(--amber)', BLUE = '#7dd3fc', GRAY = 'var(--mute)';
      const rows = [
        ['whoami', '내 소개', EM], ['Get-History', '커리어 로그', EM],
        ['Get-ChildItem .\\projects', '프로젝트 목록', EM], ['Get-Content .\\projects\\이름', '상세 열기', EM],
        ['music', '음악 플레이어', AM], ['clear', '화면 지우기', AM],
        ['contact', '게시판', BLUE], ['help', '이 도움말', GRAY],
      ];
      for (const [c, d, color] of rows) await typeHelpLine(c, d, color, token);
    })();
  }

  async function runCommand(raw) {
    const cmd = (raw || '').trim();
    if (!cmd) return;
    const token = ++typeToken;

    if (pendingAdminPw) {
      pendingAdminPw = false;
      if (input) input.value = '';
      await adminVerify(cmd, token);
      return;
    }

    streamHost.innerHTML = '';
    musicInline.classList.add('hidden');
    if (boardHost) { boardHost.innerHTML = ''; boardHost.classList.add('hidden'); }
    if (input) input.value = '';
    await typeHtmlEcho(cmd, token);

    const parsed = parseCommand(cmd);
    if (!parsed || !ALLOWED_VERBS.has(parsed.verb)) { await deny(undefined, token); return; }
    if (parsed.arg) {
      if (parsed.arg.includes('..')) { await deny('상위 경로 접근은 허용되지 않습니다.', token); return; }
      if (!SAFE_ARG.test(parsed.arg)) { await deny('인자 형식이 허용되지 않습니다.', token); return; }
    }
    const verb = parsed.verb, arg = parsed.arg;

    if (verb === ADMIN_CMD) {
      await typeLine('관리자 비밀번호를 입력하세요. (입력 내용은 화면에 표시되지 않습니다)', 'out-amber', token);
      if (input) { input.type = 'password'; input.placeholder = '비밀번호 입력'; }
      pendingAdminPw = true;
      return;
    }
    if (verb === 'help' || verb === '?') { await showHelp(token); return; }
    if (verb === 'whoami') {
      if (arg) { await deny('이 명령은 인자를 받지 않습니다.', token); return; }
      await typeLine('1998년 Visual Basic으로 코딩을 시작해, 지금은 AI 코딩과 AI 음악 도구 제작을 집중합니다.', 'out-dim', token);
      await typeLine('• Android 앱 — MyAITutor: 카메라로 문제 찍어 온디바이스 AI 풀이를 알려주는 학습 앱', 'out-dim', token);
      await typeLine('• 웹 게임 — AI_GoStop(고스톡), AI_jjangie(한국 장기): 브라우저에서 바로 즐기는 게임', 'out-dim', token);
      await typeLine('• PC 도구 — TrayTranslator, karaoke-timing-generator, Geuryeojwo 등 실생활 유틸리티', 'out-dim', token);
      await typeLine('✓ ' + (ctx.getProjectCount ? ctx.getProjectCount() : 0) + '개의 오픈소스 프로젝트를 공개 중입니다.', 'out-ok', token);
      const a = document.createElement('div');
      a.className = 'out-line mt-1';
      a.innerHTML = '<a href="https://github.com/Donian-kor/Donian-kor.github.io/blob/main/AGENTS.md" target="_blank" rel="noopener" class="text-white hover:underline underline-offset-4">AGENTS.MD 읽어보기 ↗</a>';
      streamHost.appendChild(a);
      out.scrollTop = out.scrollHeight;
      return;
    }
    if ((verb === 'history' || verb === 'get-history') && (!arg || arg.toLowerCase() === 'career.log') || (verb === 'type' && arg && arg.toLowerCase() === 'career.log')) {
      await typeLine('◆ career.log — 최근 순', 'out-head', token);
      for (const r of CAREER) await typeLine(r[0] + '  ' + r[1] + (r[2] ? '  # ' + r[2] : ''), r === CAREER[0] ? 'out-white' : 'out-muted', token);
      return;
    }
    if (verb === 'get-childitem' || verb === 'ls' || verb === 'dir') {
      await typeLine('◆ Get-ChildItem .\\projects — ' + (ctx.getProjectCount ? ctx.getProjectCount() : 0) + ' items', 'out-head', token);
      if (ctx.renderProjectList) ctx.renderProjectList();
      out.scrollTop = out.scrollHeight;
      return;
    }
    if (verb === 'cat' || verb === 'type' || verb === 'get-content') {
      if (!arg) { await deny('프로젝트 이름을 지정하세요.', token); return; }
      const name = arg.replace(/\\?\.?\\?projects\\?/i, '').replace(/\\readme\.md$/i, '').replace(/\.txt$/i, '').trim().toLowerCase();
      const p = ctx.findProject ? ctx.findProject(name) : null;
      if (p) { ctx.openModal(p); await typeLine('✓ ' + p.name + ' 상세를 열었습니다.', 'out-ok', token); }
      else await typeLine('파일을 찾을 수 없습니다: ' + escHtml(name), 'out-amber', token);
      return;
    }
    if (verb === 'music') {
      musicInline.classList.remove('hidden');
      out.scrollTop = out.scrollHeight;
      return;
    }
    if (verb === 'contact') {
      try {
        const b = await ensureBoard();
        boardHost.classList.remove('hidden');
        b.show();
        boardHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        await typeLine('✕ 게시판 모듈 로드 실패: ' + e.message, 'out-danger', token);
      }
      return;
    }
    if (verb === 'clear' || verb === 'cls') return;
    await deny(undefined, token);
  }

  const form = document.getElementById('cmd-form');
  if (form) form.addEventListener('submit', e => {
    e.preventDefault();
    const value = input ? input.value : '';
    if (input) { input.type = 'text'; input.placeholder = '명령 입력 (예: help)'; }
    runCommand(value);
  });
  const buttons = document.getElementById('cmd-buttons');
  if (buttons) buttons.addEventListener('click', e => {
    const b = e.target.closest('.cmd-chip');
    if (b) runCommand(b.dataset.cmd);
  });

  return { runCommand, addStaticLine, deny, typeLine };
}
