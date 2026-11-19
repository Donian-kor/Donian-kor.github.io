// GitHub 계정의 fork 저장소를 projects.json에 자동으로 추가한다.
// 이미 등록된 항목은 수정하지 않고, 없는 fork만 "fork" 분류로 추가한다.
import fs from 'node:fs';

const USER = 'Donian-kor';
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN이 없습니다.');
  process.exit(1);
}

const filePath = new URL('../projects.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

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
          'User-Agent': 'donian-portfolio-fork-sync',
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

for (const repo of repos.filter((r) => r.fork).reverse()) {
  const url = String(repo.html_url || '').toLowerCase();
  if (!url || existing.has(url)) continue;

  const original = repo.parent?.full_name || '';
  const description = (repo.description || '포크한 저장소').replace(/\s+/g, ' ').trim();
  const language = repo.language || 'TypeScript';

  data.projects.push({
    id: repo.name.toLowerCase(),
    name: repo.name,
    category: 'fork',
    description: `${description} (Fork from ${original})`,
    tech: [language],
    language,
    github: repo.html_url,
    demo: null,
    screenshot: null,
    forked: true,
    original,
    created_at: String(repo.created_at || '').slice(0, 10),
    updated_at: String(repo.updated_at || '').slice(0, 10),
  });

  existing.add(url);
  added++;
  console.log(`추가: ${repo.name}`);
}

if (added > 0) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}
console.log(`새 fork ${added}개 반영`);
