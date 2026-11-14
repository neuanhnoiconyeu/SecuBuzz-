require('dotenv').config({ path: require('node:path').join(__dirname, '../.env'), quiet: true });
const { openDatabase } = require('../server/database/connection');
const { migrate } = require('../server/database/migrate');
try {
    const db = openDatabase({ migrate: false });
    try {
        const result = migrate(db);
        console.log(`Database schema version ${result.version}; ${result.applied.length} migration(s) applied.`);
    } finally { db.close(); }
} catch (error) {
    console.error(error.code === 'MIGRATION_FAILED' || error.message?.startsWith('Database migration stopped:')
        ? error.message : 'Database initialization failed. Check configuration, permissions and SQLite availability.');
    process.exitCode = 1;
}
