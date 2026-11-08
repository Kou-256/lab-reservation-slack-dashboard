ALTER TABLE resources ADD COLUMN booking_pools TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(booking_pools));
ALTER TABLE reservations ADD COLUMN pool_id TEXT;
UPDATE resources SET booking_pools='[{"id":"inside","name":"ドラフト内","capacity":8},{"id":"outside","name":"ドラフト外","capacity":12}]',revision=revision+1 WHERE id='stirrer';
CREATE TABLE wash_batches(request_key TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),slack_user_id TEXT NOT NULL,rounds INTEGER NOT NULL CHECK(rounds IN(1,2)),created_at INTEGER NOT NULL);
CREATE TRIGGER resource_booking_pool_changes AFTER INSERT ON resource_changes BEGIN
  UPDATE resources SET booking_pools=coalesce(json_extract(NEW.payload,'$.after.booking_pools'),booking_pools) WHERE id=NEW.resource_id;
END;
DROP TRIGGER apply_request;
CREATE TRIGGER apply_request AFTER INSERT ON processed_requests BEGIN
  INSERT INTO reservations(id,resource_id,slack_user_id,slack_user_name,start_at,end_at,quantity,purpose,purpose_choice,status,version,created_at,updated_at,location,presenters,online_url,pool_id)
  VALUES(NEW.reservation_id,NEW.resource_id,NEW.slack_user_id,
    json_extract(NEW.payload,'$.after.slack_user_name'),json_extract(NEW.payload,'$.after.start_at'),
    json_extract(NEW.payload,'$.after.end_at'),json_extract(NEW.payload,'$.after.quantity'),
    json_extract(NEW.payload,'$.after.purpose'),json_extract(NEW.payload,'$.after.purpose_choice'),
    json_extract(NEW.payload,'$.after.status'),json_extract(NEW.payload,'$.after.version'),
    json_extract(NEW.payload,'$.after.created_at'),NEW.processed_at,coalesce(json_extract(NEW.payload,'$.after.location'),''),
    coalesce(json_extract(NEW.payload,'$.after.presenters'),'[]'),coalesce(json_extract(NEW.payload,'$.after.online_url'),''),json_extract(NEW.payload,'$.after.pool_id'))
  ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,
    quantity=excluded.quantity,purpose=excluded.purpose,purpose_choice=excluded.purpose_choice,
    status=excluded.status,version=excluded.version,updated_at=excluded.updated_at,location=excluded.location,
    presenters=excluded.presenters,online_url=excluded.online_url,pool_id=excluded.pool_id;
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
