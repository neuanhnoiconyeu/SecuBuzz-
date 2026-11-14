PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'busy')),
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS Contacts (
  contact_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  nickname TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, contact_user_id),
  CHECK (user_id <> contact_user_id),
  FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (contact_user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Messages (
  message_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT,
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT,
  read_at TEXT,
  FOREIGN KEY (sender_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
  FOREIGN KEY (recipient_id) REFERENCES Users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS SecurityLogs (
  log_id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  summary TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  finding_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (actor_user_id) REFERENCES Users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON Contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON Messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON Messages(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_securitylogs_created ON SecurityLogs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_securitylogs_severity ON SecurityLogs(severity, created_at DESC);