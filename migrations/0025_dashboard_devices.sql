-- 端末数を固定せず、端末ごとのキー・有効状態・失効世代を既存D1で管理する。
CREATE TABLE dashboard_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  key_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
