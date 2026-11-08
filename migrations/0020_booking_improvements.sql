CREATE TABLE reminder_preferences(slack_user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),enabled_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE reminder_preference_requests(request_key TEXT PRIMARY KEY,slack_user_id TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),created_at INTEGER NOT NULL);
CREATE TRIGGER apply_reminder_preference AFTER INSERT ON reminder_preference_requests BEGIN
  INSERT INTO reminder_preferences VALUES(NEW.slack_user_id,NEW.enabled,NEW.created_at,NEW.created_at)
  ON CONFLICT(slack_user_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,
    enabled_at=CASE WHEN reminder_preferences.enabled=0 AND excluded.enabled=1 THEN excluded.enabled_at ELSE reminder_preferences.enabled_at END;
END;
CREATE TABLE reminder_deliveries(reservation_id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('before','end')),slack_user_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(reservation_id,version,kind));
CREATE TABLE purpose_hidden(resource_id TEXT NOT NULL,value TEXT NOT NULL,slack_user_id TEXT NOT NULL,hidden_at INTEGER NOT NULL,PRIMARY KEY(resource_id,value));
CREATE TABLE purpose_edits(request_key TEXT PRIMARY KEY,resource_id TEXT NOT NULL,slack_user_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,operation TEXT NOT NULL CHECK(operation IN('hide','rename','restore')),source TEXT NOT NULL,target TEXT NOT NULL,options TEXT NOT NULL CHECK(json_valid(options)),created_at INTEGER NOT NULL);
CREATE TRIGGER validate_purpose_edit BEFORE INSERT ON purpose_edits BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resources WHERE id=NEW.resource_id AND schedule_event=0 AND revision=NEW.expected_revision) THEN RAISE(ABORT,'stale_purpose_edit') END;
END;
CREATE TRIGGER apply_purpose_edit AFTER INSERT ON purpose_edits BEGIN
  UPDATE resources SET purpose_options=NEW.options,revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.resource_id;
  INSERT INTO purpose_hidden SELECT NEW.resource_id,NEW.source,NEW.slack_user_id,NEW.created_at WHERE NEW.operation IN('hide','rename')
    ON CONFLICT(resource_id,value) DO UPDATE SET slack_user_id=excluded.slack_user_id,hidden_at=excluded.hidden_at;
  DELETE FROM purpose_hidden WHERE resource_id=NEW.resource_id AND value=CASE WHEN NEW.operation='restore' THEN NEW.source WHEN NEW.operation='rename' THEN NEW.target ELSE NULL END;
END;
DROP TRIGGER remember_shared_purpose;
CREATE TRIGGER remember_shared_purpose AFTER INSERT ON processed_requests
WHEN NEW.operation IN('created','updated') AND coalesce(json_extract(NEW.payload,'$.after.purpose_choice'),'')=''
  AND length(trim(json_extract(NEW.payload,'$.after.purpose'))) BETWEEN 1 AND 300 AND trim(json_extract(NEW.payload,'$.after.purpose'))<>'自由入力'
BEGIN
  UPDATE resources SET purpose_options=(SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(resources.purpose_options) WHERE value<>'自由入力'
    UNION ALL SELECT trim(json_extract(NEW.payload,'$.after.purpose')) UNION ALL SELECT '自由入力'
  )),revision=revision+1,updated_at=NEW.processed_at
  WHERE id=NEW.resource_id AND schedule_event=0 AND json_array_length(purpose_options)<9999
    AND NOT EXISTS(SELECT 1 FROM purpose_hidden WHERE resource_id=NEW.resource_id AND value=trim(json_extract(NEW.payload,'$.after.purpose')))
    AND NOT EXISTS(SELECT 1 FROM json_each(resources.purpose_options) WHERE trim(value)=trim(json_extract(NEW.payload,'$.after.purpose')));
END;
