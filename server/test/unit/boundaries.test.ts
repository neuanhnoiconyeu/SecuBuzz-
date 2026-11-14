import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}

test('the production entry point exports no session resolver, authorizer, store or verifier implementation', async () => {
  const exported = Object.keys(await import('../../src/index.ts')).sort();
  assert.deepEqual(exported, [
    'ACK_ERROR_CODES', 'CLIENT_EVENTS', 'CONNECT_ERROR_CODES', 'DEFAULT_LIMITS', 'DEFAULT_NAMESPACE', 'DEFAULT_PATH',
    'DEFAULT_RATES', 'DEFAULT_SESSION_COOKIE', 'DEFAULT_TIMING', 'RealtimeConfigError', 'SERVER_EVENTS', 'attachRealtimeServer',
    'createConsoleLogger', 'envelopeFingerprint', 'loadStandaloneConfig', 'normalizeOrigin', 'resolveRealtimeConfig', 'silentLogger',
  ]);
});

test('production sources never import test fixtures or the test harness', () => {
  for (const file of sourceFiles(join(serverRoot, 'src'))) {
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);
    assert.ok(imports.every((specifier) => !specifier.includes('test/') && !specifier.includes('fixtures')), file);
  }
});

test('test fixtures refuse to load when NODE_ENV=production', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./test/support/fixtures.ts')"], {
    cwd: serverRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must never be loaded in production/);
});
