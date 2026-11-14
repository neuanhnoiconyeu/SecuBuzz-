const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const migrationDirectory = path.join(__dirname, 'migrations');

function loadMigrations(directory = migrationDirectory) {
    return fs.readdirSync(directory).filter(name => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
        .sort().map(name => {
            const sql = fs.readFileSync(path.join(directory, name), 'utf8');
            return { version: Number(name.slice(0, 4)), name, sql,
                checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') };
        });
}
function fail(code) {
    const error = new Error(`Database migration stopped: ${code}. See DATA/docs/migrations.md.`);
    error.code = code;
    throw error;
}
// Ignore formatting outside literals without changing CHECK/default string semantics.
const normalizeSql = sql => sql.replace(/IF\s+NOT\s+EXISTS/gi, '')
    .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[^\s]/g).join('');

function validateLegacy(db, initialSql) {
    const reference = new Database(':memory:');
    try {
        reference.exec(initialSql);
        const objects = database => database.prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).all();
        const expected = objects(reference);
        const actual = objects(db);
        if (actual.length !== expected.length || actual.some((object, i) =>
            object.type !== expected[i].type || object.name !== expected[i].name ||
            normalizeSql(object.sql) !== normalizeSql(expected[i].sql))) fail('UNSUPPORTED_LEGACY_SCHEMA');
        if (db.prepare('PRAGMA foreign_key_check').all().length) fail('LEGACY_FOREIGN_KEY_VIOLATION');
        if (db.prepare(`SELECT 1 FROM Users WHERE user_id IS NULL OR length(trim(user_id)) = 0
            OR length(trim(username)) = 0 OR length(trim(display_name)) = 0
            OR created_at IS NULL OR last_seen IS NULL LIMIT 1`).get()) fail('INVALID_LEGACY_USER');
        if (db.prepare(`SELECT 1 FROM Contacts a JOIN Contacts b
            ON a.user_id = b.friend_id AND a.friend_id = b.user_id
            WHERE a.status <> b.status OR a.status = 'pending' LIMIT 1`).get()) fail('AMBIGUOUS_LEGACY_CONTACTS');
        if (db.prepare(`SELECT 1 FROM Messages WHERE sender_id = receiver_id
            OR message_id IS NULL OR length(trim(message_id)) = 0 OR length(ciphertext) = 0
            OR length(iv) = 0 OR created_at IS NULL LIMIT 1`).get()) fail('INVALID_LEGACY_MESSAGE');
    } finally { reference.close(); }
}

function migrate(db, options = {}) {
    if (db.inTransaction) fail('MIGRATION_REQUIRES_OWN_TRANSACTION');
    if (db.pragma('foreign_keys', { simple: true }) !== 1) fail('FOREIGN_KEYS_DISABLED');
    const migrations = loadMigrations(options.directory);
    if (!migrations.length || migrations.some((entry, i) => entry.version !== i + 1)) fail('INVALID_MIGRATION_ORDER');
    let currentVersion = 0;
    const applied = [];
    // One writer lock and transaction for the whole batch, including legacy adoption.
    db.transaction(() => {
        const trackingExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='SchemaMigrations'").get();
        if (!trackingExists) {
            const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
            if (existing.length) validateLegacy(db, migrations[0].sql);
            db.exec(`CREATE TABLE SchemaMigrations (
                version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )`);
        }
        const history = db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
        if (trackingExists && !history.length) fail('MIGRATION_HISTORY_MISMATCH');
        for (let i = 0; i < history.length; i++) {
            const row = history[i];
            const expected = migrations[i];
            if (!expected || row.version !== expected.version || row.name !== expected.name ||
                row.checksum !== expected.checksum) fail('MIGRATION_HISTORY_MISMATCH');
        }
        currentVersion = history.length;
        for (const migration of migrations.slice(history.length)) {
            try {
                db.exec(migration.sql);
                if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_VIOLATION');
                db.prepare('INSERT INTO SchemaMigrations(version,name,checksum) VALUES(?,?,?)')
                    .run(migration.version, migration.name, migration.checksum);
                applied.push(migration.name);
                currentVersion = migration.version;
            } catch (cause) {
                const error = new Error(`Migration ${migration.name} failed; the entire batch was rolled back. See DATA/docs/migrations.md.`);
                error.code = 'MIGRATION_FAILED';
                error.cause = cause;
                throw error;
            }
        }
    }).immediate();
    return { version: currentVersion, applied };
}
module.exports = { migrate, loadMigrations };
