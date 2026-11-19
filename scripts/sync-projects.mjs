// GitHub 계정의 공개 저장소와 projects.json을 동기화한다.
// - 없는 공개 저장소는 추가한다 (언어로 분류 추정)
// - 비공개 전환/삭제로 공개 목록에서 사라진 항목은 제거한다
// 이미 등록된 항목의 설명·스크린샷 등은 건드리지 않는다.
import fs from 'node:fs';

const USER = 'Donian-kor';
const USER_PREFIX = 'https://github.com/donian-kor/';
// 포트폴리오 저장소 자체는 프로젝트 카드에 넣지 않는다.
const EXCLUDE = new Set(['donian-kor.github.io']);

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN이 없습니다.');
  process.exit(1);
}

const filePath = new URL('../projects.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const WEB_LANGS = new Set(['JavaScript', 'TypeScript', 'HTML', 'CSS', 'Vue', 'Svelte']);
const ANDROID_LANGS = new Set(['Kotlin', 'Java', 'Swift', 'Dart']);

function categoryFor(repo) {
  if (repo.fork) return 'fork';
  const lang = repo.language || '';
  if (ANDROID_LANGS.has(lang)) return 'android';
  if (WEB_LANGS.has(lang)) return 'web';
  return 'pc';
}

function normalizeUrl(value) {
  return String(value || '').toLowerCase().replace(/\/+$/, '');
}

async function fetchRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/users/${USER}/repos?per_page=100&page=${page}&sort=created&direction=desc`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'donian-portfolio-sync',
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub API 오류: ${res.status}`);
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

const repos = await fetchRepos();
const publicRepos = repos.filter((r) => !r.private && r.visibility !== 'private');
const publicUrls = new Set(publicRepos.map((r) => normalizeUrl(r.html_url)));

const existing = new Set(data.projects.map((p) => normalizeUrl(p.github)));
let added = 0;

for (const repo of publicRepos.reverse()) {
  if (EXCLUDE.has(repo.name.toLowerCase())) continue;

  const url = normalizeUrl(repo.html_url);
  if (!url || existing.has(url)) continue;

  const original = repo.parent?.full_name || '';
  const rawDescription = (repo.description || '').replace(/\s+/g, ' ').trim();
  const description = repo.fork
    ? `${rawDescription || '포크한 저장소'} (Fork from ${original})`
    : rawDescription || 'GitHub 저장소';

  const language = repo.language || '기타';

  data.projects.push({
    id: repo.name.toLowerCase(),
    name: repo.name,
    category: categoryFor(repo),
    description,
    tech: [language],
    language,
    github: repo.html_url,
    demo: null,
    screenshot: null,
    forked: !!repo.fork,
    ...(repo.fork ? { original } : {}),
    created_at: String(repo.created_at || '').slice(0, 10),
    updated_at: String(repo.updated_at || '').slice(0, 10),
  });

  existing.add(url);
  added++;
  console.log(`추가: ${repo.name} (${categoryFor(repo)})`);
}

// 공개 목록에서 사라진 항목 제거 (비공개 전환 / 저장소 삭제 등)
// 이 계정 소유 주소만 대상으로 하고, 응답이 비정상적으로 적으면 제거를 건너뛴다.
const managed = data.projects.filter((p) => normalizeUrl(p.github).startsWith(USER_PREFIX));
const matched = managed.filter((p) => publicUrls.has(normalizeUrl(p.github))).length;
let removed = 0;

if (publicUrls.size > 0 && (managed.length < 4 || matched >= Math.ceil(managed.length * 0.5))) {
  data.projects = data.projects.filter((p) => {
    const url = normalizeUrl(p.github);
    if (!url.startsWith(USER_PREFIX) || publicUrls.has(url)) return true;
    removed++;
    console.log(`제거: ${p.name}`);
    return false;
  });
} else {
  console.warn('공개 저장소 응답이 적어 제거를 건너뜁니다.');
}

if (added > 0 || removed > 0) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}
console.log(`추가 ${added}개 / 제거 ${removed}개 반영`);
