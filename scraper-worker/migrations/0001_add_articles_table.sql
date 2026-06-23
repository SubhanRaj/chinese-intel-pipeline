CREATE TABLE IF NOT EXISTS intel_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_date TEXT NOT NULL REFERENCES intel_briefings(tracking_date),
  title TEXT,
  summary TEXT,
  full_text TEXT,
  url TEXT,
  is_preserved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
