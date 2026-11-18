-- 마이그레이션 001: 게시글 상태(문의/버그/의뢰) 컬럼 추가
-- 이미 배포된 D1 DB에 한 번만 실행하세요. (board-schema.sql은 신규 설치용)
-- 두 번 실행하면 "duplicate column name" 오류가 납니다.

ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'question';
CREATE INDEX IF NOT EXISTS idx_posts_admin_created ON posts(is_admin DESC, created_at DESC);
