-- Durable mirror of reservation changes. No reservation is modified by this migration.
CREATE TABLE IF NOT EXISTS google_calendar_sync (
  reservation_id TEXT PRIMARY KEY,
  desired_version INTEGER NOT NULL,
  synced_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  synced_calendar_id TEXT
);
CREATE TRIGGER IF NOT EXISTS queue_google_calendar_change AFTER INSERT ON processed_requests
BEGIN
  INSERT INTO google_calendar_sync(reservation_id,desired_version)
  VALUES(NEW.reservation_id,json_extract(NEW.payload,'$.after.version'))
  ON CONFLICT(reservation_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0;
END;
