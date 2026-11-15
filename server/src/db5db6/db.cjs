const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = process.cwd();
const dbFile = process.env.DB_FILE
  ? path.resolve(root, process.env.DB_FILE)
  : path.resolve(root, 'data', 'yahoo_messenger.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// The existing database/schema.sql is the schema supplied with the project.
const baseSchema = process.env.BASE_SCHEMA_FILE
  ? path.resolve(root, process.env.BASE_SCHEMA_FILE)
  : path.resolve(root, 'database', 'schema.sql');
if (!fs.existsSync(baseSchema)) {
  throw new Error(`Cannot find existing schema.sql at ${baseSchema}. Set BASE_SCHEMA_FILE to its path.`);
}
db.exec(fs.readFileSync(baseSchema, 'utf8'));

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
      description TEXT,
      created_by TEXT NOT NULL,
      history_visibility TEXT NOT NULL DEFAULT 'from_joined'
        CHECK(history_visibility IN ('all', 'from_joined')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(created_by) REFERENCES Users(user_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS GroupMembers (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
      joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      removed_at TEXT,
      PRIMARY KEY(group_id, user_id),
      FOREIGN KEY(group_id) REFERENCES Groups(group_id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES Users(user_id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_one_active_owner
      ON GroupMembers(group_id) WHERE role='owner' AND status='active';
    CREATE INDEX IF NOT EXISTS idx_groupmembers_user_status
      ON GroupMembers(user_id, status, group_id);
    CREATE TABLE IF NOT EXISTS GroupInvitations (
      invitation_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      invited_user_id TEXT NOT NULL,
      invited_by_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      responded_at TEXT,
      FOREIGN KEY(group_id) REFERENCES Groups(group_id) ON DELETE CASCADE,
      FOREIGN KEY(invited_user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
      FOREIGN KEY(invited_by_user_id) REFERENCES Users(user_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_groupinvitations_user_status
      ON GroupInvitations(invited_user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS Attachments (
      attachment_id TEXT PRIMARY KEY,
      uploader_user_id TEXT NOT NULL,
      recipient_user_id TEXT,
      group_id TEXT,
      original_name TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      encryption_algorithm TEXT,
      file_iv TEXT,
      file_auth_tag TEXT,
      metadata_ciphertext TEXT,
      metadata_iv TEXT,
      metadata_auth_tag TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT,
      deleted_at TEXT,
      CHECK ((group_id IS NOT NULL AND recipient_user_id IS NULL)
          OR (group_id IS NULL AND recipient_user_id IS NOT NULL)),
      FOREIGN KEY(uploader_user_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
      FOREIGN KEY(recipient_user_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
      FOREIGN KEY(group_id) REFERENCES Groups(group_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_group_created
      ON Attachments(group_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_direct
      ON Attachments(uploader_user_id, recipient_user_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_expiry
      ON Attachments(expires_at) WHERE deleted_at IS NULL;
  `);

  // Extend the existing Messages table rather than creating a second group-message table.
  const columns = db.prepare('PRAGMA table_info(Messages)').all().map(c => c.name);
  if (!columns.includes('group_id')) {
    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`
        CREATE TABLE Messages_new (
          message_id TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL,
          recipient_id TEXT,
          group_id TEXT,
          ciphertext TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT,
          algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          delivered_at TEXT,
          read_at TEXT,
          CHECK ((recipient_id IS NOT NULL AND group_id IS NULL)
              OR (recipient_id IS NULL AND group_id IS NOT NULL)),
          FOREIGN KEY(sender_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
          FOREIGN KEY(recipient_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
          FOREIGN KEY(group_id) REFERENCES Groups(group_id) ON DELETE CASCADE
        );
        INSERT INTO Messages_new
          (message_id,sender_id,recipient_id,group_id,ciphertext,iv,auth_tag,algorithm,created_at,delivered_at,read_at)
        SELECT message_id,sender_id,recipient_id,NULL,ciphertext,iv,auth_tag,algorithm,created_at,delivered_at,read_at
        FROM Messages;
        DROP TABLE Messages;
        ALTER TABLE Messages_new RENAME TO Messages;
        CREATE INDEX IF NOT EXISTS idx_messages_conversation
          ON Messages(sender_id, recipient_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_recipient
          ON Messages(recipient_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_group
          ON Messages(group_id, created_at);
      `);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  } else {
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_group ON Messages(group_id, created_at)');
  }
}
migrate();

module.exports = db;
