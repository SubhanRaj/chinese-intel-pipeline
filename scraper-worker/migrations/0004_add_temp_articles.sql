CREATE TABLE IF NOT EXISTS temp_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_date TEXT NOT NULL,
  title TEXT NOT NULL,
  title_en TEXT,
  full_text TEXT,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  is_important INTEGER DEFAULT 0,
  importance_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
