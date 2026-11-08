ALTER TABLE reservations ADD COLUMN location TEXT NOT NULL DEFAULT '';
DROP TRIGGER apply_request;
CREATE TRIGGER apply_request AFTER INSERT ON processed_requests BEGIN
  INSERT INTO reservations(id,resource_id,slack_user_id,slack_user_name,start_at,end_at,quantity,purpose,purpose_choice,status,version,created_at,updated_at,location)
  VALUES(NEW.reservation_id,NEW.resource_id,NEW.slack_user_id,
    json_extract(NEW.payload,'$.after.slack_user_name'),json_extract(NEW.payload,'$.after.start_at'),
    json_extract(NEW.payload,'$.after.end_at'),json_extract(NEW.payload,'$.after.quantity'),
    json_extract(NEW.payload,'$.after.purpose'),json_extract(NEW.payload,'$.after.purpose_choice'),
    json_extract(NEW.payload,'$.after.status'),json_extract(NEW.payload,'$.after.version'),
    json_extract(NEW.payload,'$.after.created_at'),NEW.processed_at,coalesce(json_extract(NEW.payload,'$.after.location'),''))
  ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,
    quantity=excluded.quantity,purpose=excluded.purpose,purpose_choice=excluded.purpose_choice,
    status=excluded.status,version=excluded.version,updated_at=excluded.updated_at,location=excluded.location;
  UPDATE resources SET revision=revision+1,updated_at=NEW.processed_at WHERE id=NEW.resource_id;
  INSERT INTO notifications(request_key) VALUES(NEW.request_key);
END;
