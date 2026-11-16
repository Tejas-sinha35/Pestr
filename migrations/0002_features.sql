-- Business profile (Claude reads this before writing emails)
ALTER TABLE users ADD COLUMN business_name TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN sign_off TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN payment_instructions TEXT DEFAULT '';

-- Plans: paid date, pay-now link, opt-in automatic sending
ALTER TABLE plans ADD COLUMN paid_at TEXT;
ALTER TABLE plans ADD COLUMN payment_url TEXT DEFAULT '';
ALTER TABLE plans ADD COLUMN auto_send INTEGER DEFAULT 0;

-- Messages: when each one went out
ALTER TABLE messages ADD COLUMN sent_at TEXT;

-- Partial payments
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  amount REAL NOT NULL, paid_on TEXT NOT NULL, note TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_payments_plan ON payments(plan_id);

-- Timeline of everything that happens to a plan
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity_plan ON activity(plan_id);

-- Speeds up "what is due today" and the cron sender
CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(status, send_on);
