CREATE TABLE IF NOT EXISTS member_names (
  slack_user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  updated_at INTEGER NOT NULL
);
