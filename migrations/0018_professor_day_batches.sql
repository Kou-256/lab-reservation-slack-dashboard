CREATE TABLE professor_day_batches (
  request_key TEXT PRIMARY KEY,base_id TEXT NOT NULL,slack_user_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL
);
CREATE TRIGGER apply_professor_day_batch AFTER INSERT ON professor_day_batches BEGIN
  INSERT INTO professor_day_requests(request_key,event_id,operation,slack_user_id,expected_version,payload,created_at)
  SELECT NEW.request_key||'_'||json_extract(item.value,'$.start_date'),json_extract(item.value,'$.id'),
    'created',NEW.slack_user_id,0,item.value,NEW.created_at FROM json_each(NEW.payload) item;
END;
