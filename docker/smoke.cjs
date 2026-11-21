'use strict';

// INFRA-01B only: run via stdin in the uniquely named disposable Compose project.
// Never import DATA's application/startup modules or open a host database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.SECUBUZZ_DOCKER_SMOKE, 'true');
  assert.notEqual(process.getuid(), 0);
  const role = process.env.SECUBUZZ_DOCKER_SMOKE_ROLE;
  assert.ok(['backend', 'frontend'].includes(role));
  const health = await fetch('http://127.0.0.1:5000/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const result = { role, node: process.version, uid: process.getuid(), backendHealth: true };
  if (role === 'backend') {
    const filename = '/var/lib/secubuzz/sqlite/database.sqlite';
    assert.equal(process.env.DB_PATH, filename);
    for (const root of ['/var/lib/secubuzz/sqlite', '/var/lib/secubuzz/attachments']) {
      fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
      assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    }
    const dataRequire = createRequire('/workspace/DATA/package.json');
    const serverRequire = createRequire('/workspace/server/package.json');
    assert.equal(typeof dataRequire('argon2').hash, 'function');
    assert.equal(typeof dataRequire('./server/e2ee/protocol.js').protocol?.createRecipientKeyVerifier, 'function');
    for (const requirePackage of [dataRequire, serverRequire]) {
      const Database = requirePackage('better-sqlite3');
      const temporary = new Database(':memory:');
      try { assert.equal(temporary.prepare('SELECT 1 AS ok').get().ok, 1); }
      finally { temporary.close(); }
    }
    assert.equal(fs.existsSync('/workspace/DATA/.env'), false);
    assert.equal(fs.existsSync('/workspace/server/.env'), false);
    assert.ok(!fs.readdirSync('/workspace/DATA/server/database').some(name => /\.(?:sqlite3?|db)(?:$|[.-])/.test(name)));
    const { loadMigrations } = dataRequire('./server/database/migrate.js');
    const expected = loadMigrations().map(({ version, name, checksum }) => ({ version, name, checksum }));
    const Database = dataRequire('better-sqlite3');
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(db.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY version').all(), expected);
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get().n, 0);
      result.migrationVersions = expected.map(row => row.version);
      result.nativeDependencies = ['DATA/better-sqlite3', 'server/better-sqlite3', 'DATA/argon2'];
      result.database = filename;
      result.journalMode = 'wal';
      result.accounts = 0;
    } finally { db.close(); }
  } else {
    const response = await fetch('http://127.0.0.1:3001/login');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(fs.existsSync('/workspace/client/.env'), false);
    assert.equal(fs.existsSync('/var/lib/secubuzz/sqlite/database.sqlite'), false);
    const me = await fetch('http://127.0.0.1:3001/api/auth/me', {
      headers: { Origin: 'http://localhost:3001' },
    });
    assert.equal(me.status, 401);
    result.frontendReachable = true;
    result.sameOriginProxyUnauthenticatedStatus = me.status;
  }
  console.log(JSON.stringify(result));
}
main().catch(() => {
  console.error('Docker smoke check failed; no credentials or database contents were logged.');
  process.exitCode = 1;
});
