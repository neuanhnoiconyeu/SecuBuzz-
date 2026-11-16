import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertDataApplication, DataBridgeError } from '../../src/data/index.ts';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataRoot = join(serverRoot, 'src', 'data');
const sources = readdirSync(dataRoot).filter((name) => name.endsWith('.ts'));

test('the bridge never imports DATA code, a database driver or test code; only the entry script loads DATA, through createRequire', () => {
  for (const name of sources) {
    const source = readFileSync(join(dataRoot, name), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      assert.doesNotMatch(specifier as string, /DATA|sqlite|better-sqlite3|express|argon2|\/test\//i, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /\brequire\s*\(/, `${name} must not call require()`);
    if (name !== 'main.ts') assert.doesNotMatch(source, /createRequire/, `${name} must not load DATA`);
  }
  assert.match(readFileSync(join(dataRoot, 'main.ts'), 'utf8'), /createRequire\(join\(dataRoot, 'package\.json'\)\)/);
});

test('the bridge reads no environment variables except the entry script\'s DATA_ROOT', () => {
  for (const name of sources) {
    const uses = [...readFileSync(join(dataRoot, name), 'utf8').matchAll(/process\.env\.[A-Z_]+/g)].map((match) => match[0]);
    assert.deepEqual(uses, name === 'main.ts' ? ['process.env.DATA_ROOT'] : [], name);
  }
});

test('the bridge never logs request bodies, cookies, tokens or envelopes', () => {
  for (const name of sources) {
    const source = readFileSync(join(dataRoot, name), 'utf8');
    for (const [call] of source.matchAll(/logger\.log\([^)]*\)/g)) {
      assert.doesNotMatch(call, /body|cookie|token|csrf|envelope|ciphertext|header/i, `${name}: ${call}`);
    }
  }
});

test('the package exposes the bridge at ./data and a start:data script', () => {
  const manifest = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./data'], './src/data/index.ts');
  assert.equal(manifest.scripts['start:data'], 'node src/data/main.ts');
});

test('a DATA application that lacks a documented method is refused at attach time', () => {
  const complete = {
    auth: { config: { origins: ['http://localhost:3000'], sessionCookie: 'secubuzz_session', allowHttpLocal: true, trustedProxyIps: [] }, csrfProof() { return null; }, checkSession() { return null; } },
    adapters: { sessionResolver: { resolveSession: async () => null } },
    conversations: { list() { return null; }, detail() { return null; } },
    social: { listBlocks() { return null; }, ownProfile() { return null; }, repository: { friendship() { return null; }, isBlocked() { return false; }, active() { return null; } } },
    keys: { state() { return null; } },
    messaging: { bindStore() { return null; }, rate() { return undefined; } },
  };
  assert.doesNotThrow(() => assertDataApplication(complete));
  assert.throws(() => assertDataApplication(null), DataBridgeError);
  assert.throws(() => assertDataApplication({}), DataBridgeError);
  for (const mutate of [
    (value: Record<string, any>) => { delete value.messaging.bindStore; },
    (value: Record<string, any>) => { delete value.auth.csrfProof; },
    (value: Record<string, any>) => { value.auth.config.origins = []; },
    (value: Record<string, any>) => { value.auth.config.sessionCookie = 7; },
    (value: Record<string, any>) => { delete value.adapters.sessionResolver.resolveSession; },
    (value: Record<string, any>) => { delete value.social.repository.isBlocked; },
    (value: Record<string, any>) => { delete value.messaging.rate; },
    (value: Record<string, any>) => { delete value.keys.state; },
    (value: Record<string, any>) => { delete value.conversations.detail; },
  ]) {
    const rebuilt: Record<string, any> = {
      auth: { ...complete.auth, config: { ...complete.auth.config } },
      adapters: { sessionResolver: { ...complete.adapters.sessionResolver } },
      conversations: { ...complete.conversations },
      social: { ...complete.social, repository: { ...complete.social.repository } },
      keys: { ...complete.keys },
      messaging: { ...complete.messaging },
    };
    mutate(rebuilt);
    assert.throws(() => assertDataApplication(rebuilt), DataBridgeError);
  }
});
