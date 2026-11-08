ALTER TABLE reservations ADD COLUMN presenters TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(presenters));
ALTER TABLE reservations ADD COLUMN online_url TEXT NOT NULL DEFAULT '';
CREATE TABLE schedule_sessions (
  id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),
  reservation_id TEXT UNIQUE REFERENCES reservations(id),session_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','undecided','not_held')),
  presenters TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(presenters)),
  notes TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_date ON schedule_sessions(resource_id,session_date);
CREATE TABLE schedule_attendance (
  session_id TEXT NOT NULL REFERENCES schedule_sessions(id),slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('attending','absent','undecided')),
  updated_at INTEGER NOT NULL,PRIMARY KEY(session_id,slack_user_id)
);
CREATE TABLE schedule_edits (
  request_key TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES schedule_sessions(id),
  slack_user_id TEXT NOT NULL,expected_version INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL
);
CREATE TABLE schedule_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TRIGGER validate_schedule_edit BEFORE INSERT ON schedule_edits BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM schedule_sessions WHERE id=NEW.session_id AND version=NEW.expected_version)
    THEN RAISE(ABORT,'stale_session') END;
END;
CREATE TRIGGER apply_schedule_edit AFTER INSERT ON schedule_edits BEGIN
  UPDATE schedule_sessions SET session_date=json_extract(NEW.payload,'$.date'),
    state=json_extract(NEW.payload,'$.state'),presenters=json_extract(NEW.payload,'$.presenters'),
    notes=json_extract(NEW.payload,'$.notes'),version=version+1,updated_at=NEW.created_at WHERE id=NEW.session_id;
  UPDATE reservations SET presenters=json_extract(NEW.payload,'$.presenters'),version=version+1,updated_at=NEW.created_at
    WHERE id=(SELECT reservation_id FROM schedule_sessions WHERE id=NEW.session_id);
  UPDATE resources SET revision=revision+1,updated_at=NEW.created_at
    WHERE id=(SELECT resource_id FROM schedule_sessions WHERE id=NEW.session_id);
  INSERT INTO google_calendar_sync(reservation_id,desired_version)
    SELECT r.id,r.version FROM reservations r JOIN schedule_sessions s ON s.reservation_id=r.id WHERE s.id=NEW.session_id
    ON CONFLICT(reservation_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0;
END;
DROP TRIGGER apply_request;
CREATE TRIGGER apply_request AFTER INSERT ON processed_requests BEGIN
  INSERT INTO reservations(id,resource_id,slack_user_id,slack_user_name,start_at,end_at,quantity,purpose,purpose_choice,status,version,created_at,updated_at,location,presenters,online_url)
  VALUES(NEW.reservation_id,NEW.resource_id,NEW.slack_user_id,
    json_extract(NEW.payload,'$.after.slack_user_name'),json_extract(NEW.payload,'$.after.start_at'),
    json_extract(NEW.payload,'$.after.end_at'),json_extract(NEW.payload,'$.after.quantity'),
    json_extract(NEW.payload,'$.after.purpose'),json_extract(NEW.payload,'$.after.purpose_choice'),
    json_extract(NEW.payload,'$.after.status'),json_extract(NEW.payload,'$.after.version'),
    json_extract(NEW.payload,'$.after.created_at'),NEW.processed_at,coalesce(json_extract(NEW.payload,'$.after.location'),''),
    coalesce(json_extract(NEW.payload,'$.after.presenters'),'[]'),coalesce(json_extract(NEW.payload,'$.after.online_url'),''))
  ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,
    quantity=excluded.quantity,purpose=excluded.purpose,purpose_choice=excluded.purpose_choice,
    status=excluded.status,version=excluded.version,updated_at=excluded.updated_at,location=excluded.location,
    presenters=excluded.presenters,online_url=excluded.online_url;
  UPDATE resources SET revision=revision+1,updated_at=NEW.processed_at WHERE id=NEW.resource_id;
  INSERT INTO notifications(request_key) VALUES(NEW.request_key);
  INSERT INTO schedule_sessions(id,resource_id,reservation_id,session_date,state,presenters,created_at,updated_at)
  SELECT NEW.reservation_id,NEW.resource_id,NEW.reservation_id,date(json_extract(NEW.payload,'$.after.start_at')/1000,'unixepoch','+9 hours'),
    CASE WHEN NEW.operation='cancelled' THEN 'not_held' WHEN json_array_length(coalesce(json_extract(NEW.payload,'$.after.presenters'),'[]'))=0 THEN 'undecided' ELSE 'held' END,
    coalesce(json_extract(NEW.payload,'$.after.presenters'),'[]'),NEW.processed_at,NEW.processed_at
  FROM resources WHERE id=NEW.resource_id AND schedule_event=1
  ON CONFLICT(reservation_id) DO UPDATE SET session_date=excluded.session_date,state=excluded.state,
    presenters=excluded.presenters,version=schedule_sessions.version+1,updated_at=excluded.updated_at;
END;
INSERT INTO schedule_sessions(id,resource_id,reservation_id,session_date,state,presenters,created_at,updated_at)
SELECT b.id,b.resource_id,b.id,date(b.start_at/1000,'unixepoch','+9 hours'),'undecided',b.presenters,b.created_at,b.updated_at
FROM reservations b JOIN resources r ON r.id=b.resource_id WHERE r.schedule_event=1 AND b.status='active';
