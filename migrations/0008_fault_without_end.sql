DROP TRIGGER maintenance_insert;
DROP TRIGGER maintenance_update;
ALTER TABLE maintenance_periods RENAME TO maintenance_periods_old;
CREATE TABLE maintenance_periods (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
  start_at INTEGER NOT NULL, end_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'inspection' CHECK(kind IN ('fault','inspection')),
  reason TEXT NOT NULL, slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((end_at IS NOT NULL AND end_at>start_at) OR (end_at IS NULL AND kind='fault'))
);
INSERT INTO maintenance_periods(id,resource_id,start_at,end_at,kind,reason,slack_user_id,status,created_at,updated_at)
SELECT id,resource_id,start_at,end_at,'inspection',reason,slack_user_id,status,created_at,updated_at FROM maintenance_periods_old;
DROP TABLE maintenance_periods_old;
CREATE INDEX maintenance_overlap ON maintenance_periods(resource_id,status,start_at,end_at);
CREATE TRIGGER maintenance_insert AFTER INSERT ON maintenance_periods BEGIN
  UPDATE resources SET revision=revision+1 WHERE id=NEW.resource_id;
END;
CREATE TRIGGER maintenance_update AFTER UPDATE ON maintenance_periods BEGIN
  UPDATE resources SET revision=revision+1 WHERE id=NEW.resource_id;
END;
