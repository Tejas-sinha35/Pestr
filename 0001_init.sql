CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL, token TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS plans(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  public_id TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL,
  client_email TEXT DEFAULT '', invoice_number TEXT NOT NULL,
  amount REAL NOT NULL, currency TEXT DEFAULT 'USD',
  due_date TEXT NOT NULL, status TEXT DEFAULT 'open',
  notes TEXT DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step INTEGER NOT NULL, tone TEXT DEFAULT '', subject TEXT NOT NULL,
  body TEXT NOT NULL, send_on TEXT NOT NULL, status TEXT DEFAULT 'scheduled');
CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_plan_step ON messages(plan_id, step);
