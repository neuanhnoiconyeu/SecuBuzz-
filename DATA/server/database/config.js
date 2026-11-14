const path = require('node:path');
const workspace = path.resolve(__dirname, '../..');

function databaseConfig(env = process.env) {
    const configured = env.DB_PATH || 'server/database/database.sqlite';
    const timeout = Number(env.DB_BUSY_TIMEOUT_MS || 5000);
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) {
        throw new Error('DB_BUSY_TIMEOUT_MS must be an integer between 0 and 60000');
    }
    return { filename: configured === ':memory:' ? configured : path.resolve(workspace, configured), timeout };
}
module.exports = { databaseConfig };
