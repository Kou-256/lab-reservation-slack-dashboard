CREATE TABLE professor_calendar_subscriptions (
  slack_user_id TEXT PRIMARY KEY,token TEXT NOT NULL UNIQUE,version INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL
);
CREATE TABLE professor_google_sync (
  event_id TEXT PRIMARY KEY,desired_version INTEGER NOT NULL,synced_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,synced_calendar_id TEXT
);
CREATE TRIGGER queue_professor_google_insert AFTER INSERT ON professor_days BEGIN
  INSERT INTO professor_google_sync(event_id,desired_version) VALUES(NEW.id,NEW.version)
  ON CONFLICT(event_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0;
END;
CREATE TRIGGER queue_professor_google_update AFTER UPDATE ON professor_days BEGIN
  INSERT INTO professor_google_sync(event_id,desired_version) VALUES(NEW.id,NEW.version)
  ON CONFLICT(event_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0;
END;
INSERT INTO professor_google_sync(event_id,desired_version) SELECT id,version FROM professor_days;
