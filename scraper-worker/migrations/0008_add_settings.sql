-- Settings table: key/value store for pipeline configuration controllable from the dashboard.
-- email_enabled: '0' = off, '1' = on. Overrides the ENABLE_EMAIL Worker secret.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('email_enabled', '0');
