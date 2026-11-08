ALTER TABLE resources ADD COLUMN equipment_label TEXT NOT NULL DEFAULT '';
ALTER TABLE resources ADD COLUMN room TEXT NOT NULL DEFAULT '';
ALTER TABLE operation_panels ADD COLUMN equipment_page INTEGER NOT NULL DEFAULT 0;
UPDATE resources SET equipment_label=CASE WHEN instr(name,'(')>0 THEN substr(name,1,instr(name,'(')-1) ELSE name END,
  room=CASE WHEN instr(name,'(')>0 AND substr(name,-1)=')' THEN substr(name,instr(name,'(')+1,length(name)-instr(name,'(')-1) ELSE '' END WHERE schedule_event=0;
CREATE TABLE resource_changes (
  request_key TEXT PRIMARY KEY,resource_id TEXT NOT NULL,slack_user_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('created','updated','disabled','restored')),
  expected_revision INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL
);
CREATE TABLE resource_display_sync(resource_id TEXT PRIMARY KEY,desired_revision INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TRIGGER validate_resource_change BEFORE INSERT ON resource_changes BEGIN
  SELECT CASE WHEN NEW.operation='created' AND EXISTS(SELECT 1 FROM resources WHERE id=NEW.resource_id)
    THEN RAISE(ABORT,'resource_exists') END;
  SELECT CASE WHEN NEW.operation<>'created' AND NOT EXISTS(SELECT 1 FROM resources WHERE id=NEW.resource_id AND schedule_event=0 AND revision=NEW.expected_revision)
    THEN RAISE(ABORT,'stale_resource') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM resources WHERE id<>NEW.resource_id AND schedule_event=0 AND enabled=1
    AND name=json_extract(NEW.payload,'$.after.name')) AND json_extract(NEW.payload,'$.after.enabled')=1
    THEN RAISE(ABORT,'duplicate_resource_name') END;
END;
CREATE TRIGGER apply_resource_change AFTER INSERT ON resource_changes BEGIN
  INSERT INTO resources(id,channel_id,name,type,capacity,enabled,multi_day,purpose_options,revision,created_at,updated_at,icon,equipment_label,room)
  VALUES(NEW.resource_id,json_extract(NEW.payload,'$.after.channel_id'),json_extract(NEW.payload,'$.after.name'),
    json_extract(NEW.payload,'$.after.type'),json_extract(NEW.payload,'$.after.capacity'),json_extract(NEW.payload,'$.after.enabled'),
    json_extract(NEW.payload,'$.after.multi_day'),json_extract(NEW.payload,'$.after.purpose_options'),0,NEW.created_at,NEW.created_at,
    json_extract(NEW.payload,'$.after.icon'),json_extract(NEW.payload,'$.after.equipment_label'),json_extract(NEW.payload,'$.after.room'))
  ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,name=excluded.name,capacity=excluded.capacity,enabled=excluded.enabled,
    multi_day=excluded.multi_day,icon=excluded.icon,equipment_label=excluded.equipment_label,room=excluded.room,
    revision=resources.revision+1,updated_at=NEW.created_at;
  UPDATE reservations SET version=version+1,updated_at=NEW.created_at WHERE resource_id=NEW.resource_id
    AND NEW.operation='updated' AND (json_extract(NEW.payload,'$.before.name')<>json_extract(NEW.payload,'$.after.name')
      OR json_extract(NEW.payload,'$.before.channel_id')<>json_extract(NEW.payload,'$.after.channel_id'));
  INSERT INTO google_calendar_sync(reservation_id,desired_version)
    SELECT id,version FROM reservations WHERE resource_id=NEW.resource_id AND NEW.operation='updated'
      AND (json_extract(NEW.payload,'$.before.name')<>json_extract(NEW.payload,'$.after.name')
        OR json_extract(NEW.payload,'$.before.channel_id')<>json_extract(NEW.payload,'$.after.channel_id'))
    ON CONFLICT(reservation_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0;
  INSERT INTO resource_display_sync SELECT id,revision,0,NEW.created_at FROM resources WHERE id=NEW.resource_id
    ON CONFLICT(resource_id) DO UPDATE SET desired_revision=excluded.desired_revision,offset=0,updated_at=excluded.updated_at;
END;
CREATE TRIGGER maintenance_resource_revision_insert AFTER INSERT ON maintenance_periods BEGIN
  UPDATE resources SET revision=revision+1 WHERE id=NEW.resource_id;
END;
CREATE TRIGGER maintenance_resource_revision_update AFTER UPDATE ON maintenance_periods BEGIN
  UPDATE resources SET revision=revision+1 WHERE id=NEW.resource_id;
END;
