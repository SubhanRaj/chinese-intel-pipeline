-- Users known to the system (seeded manually or via admin panel)
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT    UNIQUE NOT NULL,
  name                TEXT    NOT NULL,
  role                TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  email_notifications INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One-time magic-link tokens (token stored as SHA-256 hash, never plaintext)
CREATE TABLE IF NOT EXISTS auth_magic_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Active sessions (session ID stored as SHA-256 hash, never plaintext)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT,
  persistent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Seed admin account
INSERT OR IGNORE INTO users (email, name, role, email_notifications)
VALUES ('shubhanraj2002@gmail.com', 'Subhan', 'admin', 1);
