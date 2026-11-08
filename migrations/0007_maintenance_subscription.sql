CREATE TABLE maintenance_periods (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL CHECK(end_at>start_at),
  reason TEXT NOT NULL, slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX maintenance_overlap ON maintenance_periods(resource_id,status,start_at,end_at);
CREATE TRIGGER maintenance_insert AFTER INSERT ON maintenance_periods BEGIN
  UPDATE resources SET revision=revision+1 WHERE id=NEW.resource_id;
END;
CREATE TRIGGER maintenance_update AFTER UPDATE ON maintenance_periods BEGIN
  UPDATE resources SET revision=revision+1 WHERE id=NEW.resource_id;
END;
ALTER TABLE calendar_subscriptions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar_subscriptions ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
