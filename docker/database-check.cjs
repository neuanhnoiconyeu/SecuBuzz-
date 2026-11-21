'use strict';

// Read-only verification of a disposable Docker database, never a host DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
assert.equal(process.env.SECUBUZZ_DOCKER_VALIDATION, 'true');
const filename = '/var/lib/secubuzz/sqlite/database.sqlite';
assert.equal(process.env.DB_PATH, filename);
const requireData = createRequire('/workspace/DATA/package.json');
const Database = requireData('better-sqlite3');
const db = new Database(filename, { readonly: true, fileMustExist: true });
try {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const expected = requireData('./server/database/migrate.js').loadMigrations().map(({ version, name, checksum }) => ({ version, name, checksum }));
  assert.deepEqual(db.prepare('SELECT version,name,checksum FROM SchemaMigrations ORDER BY version').all(), expected);
  const snapshot = {};
  for (const [table, order] of [['Users','user_id'], ['Conversations','conversation_id'], ['Messages','message_id'], ['DeviceKeys','device_key_id']]) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    // User last_seen/presence may change normally; retain stable identity fields.
    const stable = table === 'Users' ? rows.map(row => ({ id: row.user_id, username: row.username })) : rows;
    snapshot[table] = { count: rows.length, digest: createHash('sha256').update(JSON.stringify(stable)).digest('hex') };
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM (SELECT conversation_id,client_id FROM Messages WHERE client_id IS NOT NULL GROUP BY conversation_id,client_id HAVING count(*)>1)').get().n, 0);
  const directory = '/var/lib/secubuzz/sqlite';
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  console.log(JSON.stringify({ snapshot, migrations: expected.map(row => row.version), integrity: 'ok', foreignKeyViolations: 0,
    journal: db.pragma('journal_mode', { simple: true }), mode: '0700', files: fs.readdirSync(directory).sort() }));
} finally { db.close(); }
