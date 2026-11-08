CREATE TABLE meeting_creations (
  request_key TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,slack_user_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL
);
CREATE TRIGGER validate_meeting_creation BEFORE INSERT ON meeting_creations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM schedule_sessions WHERE resource_id='english_seminar'
    AND session_date=json_extract(NEW.payload,'$.date')) THEN RAISE(ABORT,'duplicate_meeting_date') END;
END;
CREATE TRIGGER apply_meeting_creation AFTER INSERT ON meeting_creations BEGIN
  INSERT INTO schedule_sessions(id,resource_id,session_date,state,presenters,notes,created_at,updated_at)
  VALUES(NEW.session_id,'english_seminar',json_extract(NEW.payload,'$.date'),json_extract(NEW.payload,'$.state'),
    json_extract(NEW.payload,'$.presenters'),json_extract(NEW.payload,'$.notes'),NEW.created_at,NEW.created_at);
END;
