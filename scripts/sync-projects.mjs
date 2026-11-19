// GitHub 계정의 공개 저장소를 projects.json에 자동으로 추가한다.
// 이미 등록된 항목은 수정하지 않고, 없는 저장소만 분류를 추정해 추가한다.
// 비공개 저장소는 절대 추가하지 않으며, 공개로 전환된 뒤 다음 실행 때 추가된다.
import fs from 'node:fs';

const USER = 'Donian-kor';
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
const existing = new Set(data.projects.map((p) => String(p.github || '').toLowerCase()));
let added = 0;

for (const repo of repos.reverse()) {
  // 공개 저장소만 대상으로 한다 (비공개 유출 방지).
  if (repo.private || repo.visibility === 'private') continue;
  if (EXCLUDE.has(repo.name.toLowerCase())) continue;

  const url = String(repo.html_url || '').toLowerCase();
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

if (added > 0) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}
console.log(`새 프로젝트 ${added}개 반영`);
