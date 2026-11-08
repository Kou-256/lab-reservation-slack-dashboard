CREATE TABLE maintenance_updates (
  id TEXT PRIMARY KEY,
  maintenance_id TEXT NOT NULL REFERENCES maintenance_periods(id),
  slack_user_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 1000),
  created_at INTEGER NOT NULL
);
CREATE INDEX maintenance_updates_history ON maintenance_updates(maintenance_id,created_at);
