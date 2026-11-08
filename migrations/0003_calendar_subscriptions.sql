-- Calendar subscriptions are opt-in. Existing reservations are untouched.
CREATE TABLE IF NOT EXISTS calendar_subscriptions (
  slack_user_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
