-- Shared seminar/report editing; equipment stays owner-only. Actor remains in processed_requests.
DROP TRIGGER validate_request;
CREATE TRIGGER validate_request BEFORE INSERT ON processed_requests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM resources WHERE id=NEW.resource_id AND revision=NEW.expected_revision
  ) THEN RAISE(ABORT,'stale_resource') END;
  SELECT CASE WHEN NEW.operation!='created' AND NOT EXISTS (
    SELECT 1 FROM reservations WHERE id=NEW.reservation_id AND resource_id=NEW.resource_id
      AND (slack_user_id=NEW.slack_user_id OR EXISTS(SELECT 1 FROM resources r WHERE r.id=NEW.resource_id
        AND r.schedule_event=1 AND r.id IN ('english_seminar','biweekly_report'))) AND status='active'
      AND slack_user_id=json_extract(NEW.payload,'$.after.slack_user_id')
      AND version=json_extract(NEW.payload,'$.before.version')
  ) THEN RAISE(ABORT,'stale_reservation') END;
  SELECT CASE WHEN NEW.operation='created' AND EXISTS (
    SELECT 1 FROM reservations WHERE id=NEW.reservation_id
  ) THEN RAISE(ABORT,'duplicate_reservation') END;
END;
