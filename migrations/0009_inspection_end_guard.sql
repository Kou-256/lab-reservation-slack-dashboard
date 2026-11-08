CREATE TRIGGER maintenance_inspection_end_insert BEFORE INSERT ON maintenance_periods
WHEN NEW.kind='inspection' AND NEW.end_at IS NULL BEGIN
  SELECT RAISE(ABORT,'inspection_end_required');
END;
CREATE TRIGGER maintenance_inspection_end_update BEFORE UPDATE ON maintenance_periods
WHEN NEW.kind='inspection' AND NEW.end_at IS NULL BEGIN
  SELECT RAISE(ABORT,'inspection_end_required');
END;
