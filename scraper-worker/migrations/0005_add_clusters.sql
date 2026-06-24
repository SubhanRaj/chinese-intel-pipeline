CREATE TABLE IF NOT EXISTS intel_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_date TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  category TEXT,
  sources TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

ALTER TABLE intel_articles ADD COLUMN cluster_id INTEGER;
