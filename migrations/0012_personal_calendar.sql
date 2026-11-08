ALTER TABLE calendar_subscriptions ADD COLUMN personal_token TEXT;
CREATE UNIQUE INDEX personal_calendar_token ON calendar_subscriptions(personal_token) WHERE personal_token IS NOT NULL;
