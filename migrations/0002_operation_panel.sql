-- Additive and repeatable; existing reservations and notification links are untouched.
CREATE TABLE IF NOT EXISTS operation_panels (
  channel_id TEXT PRIMARY KEY,
  message_ts TEXT,
  state TEXT NOT NULL CHECK(state IN ('posting','ready','uncertain')),
  updated_at INTEGER NOT NULL
);
