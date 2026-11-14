const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { databaseConfig } = require('./config');
const { migrate } = require('./migrate');

// Caller owns and closes the connection. Importing this module has no DB side effects.
function openDatabase(options = {}) {
    const config = { ...databaseConfig(), ...options };
    if (config.filename !== ':memory:') fs.mkdirSync(path.dirname(config.filename), { recursive: true });
    const db = new Database(config.filename, { timeout: config.timeout });
    try {
        db.pragma('foreign_keys = ON');
        db.pragma('journal_mode = WAL');
        if (config.migrate !== false) migrate(db);
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}
module.exports = { openDatabase };
