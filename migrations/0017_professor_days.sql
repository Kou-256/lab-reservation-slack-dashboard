CREATE TABLE professor_days (
  id TEXT PRIMARY KEY,start_date TEXT NOT NULL,end_date TEXT NOT NULL,
  start_at INTEGER NOT NULL,end_at INTEGER NOT NULL CHECK(end_at>start_at),
  all_day INTEGER NOT NULL CHECK(all_day IN(0,1)),title TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN('active','cancelled')),version INTEGER NOT NULL,
  created_by TEXT NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX professor_days_dates ON professor_days(status,end_at,start_at);
CREATE TABLE professor_day_requests (
  request_key TEXT PRIMARY KEY,event_id TEXT NOT NULL,operation TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,expected_version INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL
);
CREATE TABLE professor_panels (
  id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,message_ts TEXT,state TEXT NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TRIGGER validate_professor_request BEFORE INSERT ON professor_day_requests BEGIN
  SELECT CASE WHEN NEW.operation='created' AND EXISTS(SELECT 1 FROM professor_days WHERE id=NEW.event_id)
    THEN RAISE(ABORT,'duplicate_professor_event') END;
  SELECT CASE WHEN NEW.operation<>'created' AND NOT EXISTS(SELECT 1 FROM professor_days WHERE id=NEW.event_id
    AND status='active' AND version=NEW.expected_version) THEN RAISE(ABORT,'stale_professor_event') END;
END;
CREATE TRIGGER apply_professor_request AFTER INSERT ON professor_day_requests BEGIN
  INSERT INTO professor_days VALUES(NEW.event_id,json_extract(NEW.payload,'$.start_date'),json_extract(NEW.payload,'$.end_date'),
    json_extract(NEW.payload,'$.start_at'),json_extract(NEW.payload,'$.end_at'),json_extract(NEW.payload,'$.all_day'),
    json_extract(NEW.payload,'$.title'),json_extract(NEW.payload,'$.notes'),json_extract(NEW.payload,'$.status'),
    json_extract(NEW.payload,'$.version'),json_extract(NEW.payload,'$.created_by'),NEW.slack_user_id,
    json_extract(NEW.payload,'$.created_at'),NEW.created_at)
  ON CONFLICT(id) DO UPDATE SET start_date=excluded.start_date,end_date=excluded.end_date,start_at=excluded.start_at,end_at=excluded.end_at,
    all_day=excluded.all_day,title=excluded.title,notes=excluded.notes,status=excluded.status,version=excluded.version,
    updated_by=excluded.updated_by,updated_at=excluded.updated_at;
END;
