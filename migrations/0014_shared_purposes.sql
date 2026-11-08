-- This runs in the same transaction as the reservation. Failed or retried
-- reservations cannot add duplicate choices. Existing choices keep their order.
CREATE TRIGGER IF NOT EXISTS remember_shared_purpose AFTER INSERT ON processed_requests
WHEN NEW.operation IN ('created','updated')
  AND coalesce(json_extract(NEW.payload,'$.after.purpose_choice'),'')=''
  AND length(trim(json_extract(NEW.payload,'$.after.purpose'))) BETWEEN 1 AND 300
  AND trim(json_extract(NEW.payload,'$.after.purpose'))<>'自由入力'
BEGIN
  UPDATE resources SET purpose_options=(
    SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(resources.purpose_options) WHERE value<>'自由入力'
      UNION ALL SELECT trim(json_extract(NEW.payload,'$.after.purpose'))
      UNION ALL SELECT '自由入力'
    )
  ),revision=revision+1,updated_at=NEW.processed_at
  WHERE id=NEW.resource_id AND schedule_event=0
    AND json_array_length(purpose_options)<9999
    AND NOT EXISTS (SELECT 1 FROM json_each(resources.purpose_options)
      WHERE trim(value)=trim(json_extract(NEW.payload,'$.after.purpose')));
END;
