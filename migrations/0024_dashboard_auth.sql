-- 予約の保存先は変更せず、タブレット認証だけを既存D1に追加する。
CREATE TABLE dashboard_members (
  slack_user_id TEXT PRIMARY KEY REFERENCES member_names(slack_user_id),
  pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
-- 固定時間窓の試行回数をDBで原子的に管理し、別Workerからの並列試行も制限する。
CREATE TABLE dashboard_auth_attempts (
  bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX dashboard_auth_expiry ON dashboard_auth_attempts(expires_at);
-- 同じ予約送信を二重登録しないための内容照合（PIN・氏名は保存しない）。
CREATE TABLE dashboard_operations (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
