import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const e2eeRoot = join(serverRoot, 'src', 'e2ee');
const sources = readdirSync(e2eeRoot).filter((name) => name.endsWith('.ts'));

test('the e2ee entry point exports the protocol API and no test doubles', async () => {
  const exported = Object.keys(await import('../../src/e2ee/index.ts')).sort();
  assert.deepEqual(exported, [
    'ALGORITHMS', 'BYTE_LENGTHS', 'E2EE_LIMITS', 'E2EE_PROTOCOL', 'ENVELOPE_VERSION_2', 'HPKE_SUITE', 'LABELS', 'RecipientKeyServiceUnavailableError',
    'canonicalJson', 'createRecipientKeyVerifier', 'decodeBase64Url', 'deviceKeyIdFor', 'envelopeV2Fingerprint', 'epochStatement', 'evaluateRecipientKeys',
    'isCanonicalTimestamp', 'isP256PublicKey', 'messageAadV2', 'parseConversationKeyState', 'parseMessageEnvelopeV2', 'parseStoredDeviceKey', 'parseStoredEpoch',
    'planDeviceRegistration', 'planDeviceRevocation', 'planEpochPublication', 'recipientSetDigest', 'registrationStatement', 'validateDeviceRegistration',
    'verifyRecipientKeysSync', 'wrapInfo',
  ].sort());
  const manifest = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./e2ee'], './src/e2ee/index.ts');
});

test('e2ee sources import only node:crypto and small realtime helpers, never sockets, AI or tests', () => {
  const allowed = new Set(['node:crypto', '../realtime/validation.ts', '../realtime/adapterCall.ts', '../realtime/logger.ts', '../realtime/contracts.ts']);
  for (const name of sources) {
    const source = readFileSync(join(e2eeRoot, name), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(allowed.has(specifier as string) || /^\.\/[a-z]+\.ts$/.test(specifier as string), `${name} imports ${specifier}`);
    }
  }
});

test('no environment variable can enable verification: the only check refuses test-only directories in production', () => {
  for (const name of sources) {
    const uses = [...readFileSync(join(e2eeRoot, name), 'utf8').matchAll(/process\.env\.[A-Z_]+/g)].map((match) => match[0]);
    assert.deepEqual(uses, name === 'verifier.ts' ? ['process.env.NODE_ENV'] : [], name);
  }
});

test('DATA can require the library from CommonJS in production, and production refuses a test-only directory', () => {
  const script = [
    "const e2ee = require('./src/e2ee/index.ts');",
    "try { e2ee.createRecipientKeyVerifier({ directory: { testOnly: true, loadConversationKeyState() { return null; } } }); console.log('accepted'); }",
    "catch (error) { console.log('refused:' + error.message); }",
    "console.log(typeof e2ee.createRecipientKeyVerifier({ directory: { loadConversationKeyState() { return null; } } }).verifyEnvelope);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], {
    cwd: serverRoot, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /refused:A test-only key directory cannot be used in production\./);
  assert.match(result.stdout, /function/);
});
