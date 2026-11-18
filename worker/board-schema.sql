-- 게시판 테이블
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  password_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  is_locked INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'question'
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  parent_id INTEGER,
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- 조회수 중복 방지 (IP당 24시간 1회) - KV 대신 D1 사용
CREATE TABLE IF NOT EXISTS post_views (
  post_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, ip)
);

-- 레이트리밋 카운터 (글/댓글/수정/비번실패) - KV 대신 D1 사용
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_admin_created ON posts(is_admin DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);