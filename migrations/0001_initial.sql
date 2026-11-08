CREATE TABLE resources (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('exclusive_room','quantity_resource')),
  capacity INTEGER CHECK(capacity IS NULL OR capacity > 0),
  enabled INTEGER NOT NULL DEFAULT 1, multi_day INTEGER NOT NULL DEFAULT 1,
  purpose_options TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE reservations (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
  slack_user_id TEXT NOT NULL, slack_user_name TEXT NOT NULL,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL CHECK(end_at > start_at),
  quantity INTEGER NOT NULL CHECK(quantity > 0), purpose TEXT NOT NULL DEFAULT '',
  purpose_choice TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('active','cancelled')),
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX reservations_overlap ON reservations(resource_id,status,start_at,end_at);
CREATE INDEX reservations_owner ON reservations(slack_user_id,status,end_at);
CREATE TABLE panel_messages (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id), channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE processed_requests (
  request_key TEXT PRIMARY KEY, reservation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resources(id), slack_user_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('created','updated','cancelled')),
  expected_revision INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  processed_at INTEGER NOT NULL
);
CREATE TABLE notifications (
  request_key TEXT PRIMARY KEY REFERENCES processed_requests(request_key),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  message_ts TEXT, error TEXT, attempted_at INTEGER, finished_at INTEGER
);
-- The compare-and-swap and all mutations are one SQLite statement/transaction.
-- A concurrent booking forces the caller to reread and recompute capacity.
CREATE TRIGGER validate_request BEFORE INSERT ON processed_requests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM resources WHERE id=NEW.resource_id AND revision=NEW.expected_revision
  ) THEN RAISE(ABORT,'stale_resource') END;
  SELECT CASE WHEN NEW.operation!='created' AND NOT EXISTS (
    SELECT 1 FROM reservations WHERE id=NEW.reservation_id AND resource_id=NEW.resource_id
      AND slack_user_id=NEW.slack_user_id AND status='active'
      AND version=json_extract(NEW.payload,'$.before.version')
  ) THEN RAISE(ABORT,'stale_reservation') END;
  SELECT CASE WHEN NEW.operation='created' AND EXISTS (
    SELECT 1 FROM reservations WHERE id=NEW.reservation_id
  ) THEN RAISE(ABORT,'duplicate_reservation') END;
END;
CREATE TRIGGER apply_request AFTER INSERT ON processed_requests BEGIN
  INSERT INTO reservations(id,resource_id,slack_user_id,slack_user_name,start_at,end_at,quantity,purpose,purpose_choice,status,version,created_at,updated_at)
  VALUES(NEW.reservation_id,NEW.resource_id,NEW.slack_user_id,
    json_extract(NEW.payload,'$.after.slack_user_name'),json_extract(NEW.payload,'$.after.start_at'),
    json_extract(NEW.payload,'$.after.end_at'),json_extract(NEW.payload,'$.after.quantity'),
    json_extract(NEW.payload,'$.after.purpose'),json_extract(NEW.payload,'$.after.purpose_choice'),
    json_extract(NEW.payload,'$.after.status'),json_extract(NEW.payload,'$.after.version'),
    json_extract(NEW.payload,'$.after.created_at'),NEW.processed_at)
  ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,
    quantity=excluded.quantity,purpose=excluded.purpose,purpose_choice=excluded.purpose_choice,
    status=excluded.status,version=excluded.version,updated_at=excluded.updated_at;
  UPDATE resources SET revision=revision+1,updated_at=NEW.processed_at WHERE id=NEW.resource_id;
  INSERT INTO notifications(request_key) VALUES(NEW.request_key);
END;
