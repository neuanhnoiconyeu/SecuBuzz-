const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const defaultDbFile = path.resolve(process.cwd(), 'data', 'yahoo_messenger.db');
const dbFile = process.env.DB_FILE ? path.resolve(process.cwd(), process.env.DB_FILE) : defaultDbFile;
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
