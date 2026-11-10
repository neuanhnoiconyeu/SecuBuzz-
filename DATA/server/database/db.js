
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const dbPath = path.resolve(
    process.env.DB_PATH || "server/database/database.sqlite"
);

// Create database directory if it doesn't exist
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Connect to SQLite
const db = new Database(dbPath);

// Database configuration
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Load and execute schema
const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

db.exec(schema);

console.log("SQLite database initialized successfully.");

module.exports = db;