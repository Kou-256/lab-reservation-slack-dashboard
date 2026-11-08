-- Synthetic test fixture. Never run against production.

INSERT INTO member_names(slack_user_id,name,updated_at) VALUES
('UEXAMPLE0007','利用者A',unixepoch()*1000),
('UEXAMPLE0008','利用者B',unixepoch()*1000),
('UEXAMPLE0009','利用者C',unixepoch()*1000),
('UEXAMPLE0010','利用者D',unixepoch()*1000),
('UEXAMPLE0011','利用者E',unixepoch()*1000),
('UEXAMPLE0005','利用者F',unixepoch()*1000)
ON CONFLICT(slack_user_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at;

UPDATE resources SET revision=revision+1 WHERE id IN
  (SELECT resource_id FROM reservations r JOIN member_names m USING(slack_user_id) WHERE r.slack_user_name<>m.name);
UPDATE reservations SET slack_user_name=(SELECT name FROM member_names WHERE slack_user_id=reservations.slack_user_id),
  version=version+1,updated_at=unixepoch()*1000
WHERE slack_user_id IN (SELECT slack_user_id FROM member_names)
  AND slack_user_name<>(SELECT name FROM member_names WHERE slack_user_id=reservations.slack_user_id);


UPDATE processed_requests SET payload=CASE WHEN json_type(payload,'$.before')='object'
  THEN json_set(payload,'$.before.slack_user_name',(SELECT name FROM member_names WHERE slack_user_id=processed_requests.slack_user_id),
    '$.after.slack_user_name',(SELECT name FROM member_names WHERE slack_user_id=processed_requests.slack_user_id))
  ELSE json_set(payload,'$.after.slack_user_name',(SELECT name FROM member_names WHERE slack_user_id=processed_requests.slack_user_id)) END
WHERE slack_user_id IN (SELECT slack_user_id FROM member_names);

INSERT INTO google_calendar_sync(reservation_id,desired_version)
SELECT id,version FROM reservations WHERE slack_user_id IN (SELECT slack_user_id FROM member_names)
ON CONFLICT(reservation_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0;
