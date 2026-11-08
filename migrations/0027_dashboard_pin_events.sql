-- PINの生データ・ハッシュ・変更前後の値は履歴に含めない。
CREATE TABLE dashboard_pin_events (
  id TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL REFERENCES member_names(slack_user_id),
  action TEXT NOT NULL CHECK(action IN ('changed','reset','disabled')),
  actor TEXT NOT NULL CHECK(actor IN ('self','admin')),
  created_at INTEGER NOT NULL
);
