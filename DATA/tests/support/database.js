const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { openDatabase } = require('../../server/database/connection');
const { createRepositories } = require('../../server/database/repositories');

function temporary(t, beforeCleanup = () => {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secubuzz-db1-'));
    t.after(() => {
        beforeCleanup();
        // Delete only known fixture files; never recursively remove a computed path.
        for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory,name));
        fs.rmdirSync(directory);
    });
    return directory;
}
function fixture(t, options = {}) {
    const connections = [];
    const directory = temporary(t, () => {
        for (const connection of [...connections].reverse()) if (connection.open) connection.close();
    });
    const filename = path.join(directory, 'test.sqlite');
    const db = openDatabase({ filename, ...options });
    connections.push(db);
    return { db, filename, directory, connections, repositories:createRepositories(db) };
}
function legacy(t) {
    const f = fixture(t, { migrate:false });
    f.db.exec(fs.readFileSync(path.join(__dirname, '../../server/database/migrations/0001-legacy.sql'),'utf8'));
    return f;
}
// Test-only, explicit fixtures; never imported by application initialization.
function users(repositories) {
    return ['a','b','c'].map(id => repositories.users.create({ user_id:id,username:`fixture-${id}`,display_name:`Fixture ${id}` }));
}
function direct(repositories) {
    users(repositories);
    return repositories.conversations.create({conversation_id:'dm',kind:'direct',dm_user_low:'a',dm_user_high:'b'});
}
function encrypted(overrides = {}) {
    return {message_id:'message',conversation_id:'dm',sender_id:'a',receiver_id:'b',ciphertext:'opaque ciphertext, not plaintext',iv:'opaque-iv',
        envelope_version:1,encoding:'base64',sender_name:'Fixture a',client_timestamp:'2026-01-01T00:00:00.000Z',message_type:'text',
        fingerprint:'a'.repeat(64),client_id:'client-message',...overrides};
}
module.exports = { temporary,fixture,legacy,users,direct,encrypted,Database };
