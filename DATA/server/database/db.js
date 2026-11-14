
require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env'), quiet: true });
const { openDatabase } = require('./connection');

// Compatibility singleton for existing Express routes and audit reports.
// Tests and new integrations should use openDatabase() with an explicit filename.
module.exports = openDatabase();
