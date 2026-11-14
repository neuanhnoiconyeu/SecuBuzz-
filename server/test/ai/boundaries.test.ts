import './support/noNetwork.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.next')) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path, pattern) : pattern.test(entry.name) ? [path] : [];
  });
}

test('the AI entry point exports the integration API and no test doubles', async () => {
  const exported = Object.keys(await import('../../src/ai/index.ts')).sort();
  assert.deepEqual(exported, [
    'AI_CONTRACT_MAX_INPUT', 'AI_CONTRACT_MAX_OUTPUT', 'AI_DISCLOSURE', 'AI_ERRORS', 'AI_ERROR_CODES', 'AI_LANGUAGES', 'AI_LIMIT_DEFAULTS',
    'AI_SUPPORTED_MODELS', 'AI_TASKS', 'AI_TONES', 'AiConfig', 'AiConfigError', 'CONSENT_TTL_SECONDS', 'DEFAULT_AI_BASE_PATH',
    'MemoryAiUsageStore', 'computePayloadDigest', 'createAiHttpHandler', 'loadAiConfig', 'pacificDayKey', 'secondsUntilNextPacificMidnight',
  ].sort());
  const manifest = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./ai'], './src/ai/index.ts');
  assert.equal(manifest.scripts['ai:check-config'], 'node --env-file-if-exists=.env src/ai/checkConfig.ts');
});

test('only the Gemini adapter knows the Google endpoint, and nothing weakens TLS', () => {
  for (const file of files(join(serverRoot, 'src'), /\.ts$/)) {
    const source = readFileSync(file, 'utf8');
    const name = relative(serverRoot, file).replaceAll('\\', '/');
    if (name !== 'src/ai/gemini.ts') assert.ok(!source.includes('generativelanguage.googleapis.com'), name);
    assert.ok(!/process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=/.test(source), name);
    assert.ok(!/rejectUnauthorized\s*:\s*false/.test(source), name);
    assert.ok(!/setGlobalDispatcher|new\s+(?:Agent|ProxyAgent|Dispatcher)\s*\(/.test(source), name);
    assert.ok(!source.includes('@google/genai'), name);
  }
});

test('browser code never contains a Gemini endpoint, key variable or key header', () => {
  for (const file of files(join(repositoryRoot, 'client', 'src'), /\.(?:ts|tsx|js|jsx)$/)) {
    const source = readFileSync(file, 'utf8');
    const name = relative(repositoryRoot, file);
    for (const forbidden of ['generativelanguage.googleapis.com', 'GEMINI_API_KEY', 'x-goog-api-key', 'NEXT_PUBLIC_GEMINI']) {
      assert.ok(!source.includes(forbidden), `${name} contains ${forbidden}`);
    }
  }
  const clientTemplate = readFileSync(join(repositoryRoot, 'client', '.env.example'), 'utf8');
  assert.ok(!clientTemplate.includes('GEMINI_API_KEY') && !clientTemplate.includes('NEXT_PUBLIC_GEMINI'));
  assert.match(clientTemplate, /^NEXT_PUBLIC_AI_REMOTE_READY=false$/m);
});

test('the committed server template keeps remote AI off and holds no key', () => {
  const template = readFileSync(join(serverRoot, '.env.example'), 'utf8');
  assert.match(template, /^AI_REMOTE_ENABLED=false$/m);
  assert.match(template, /^GEMINI_API_KEY=$/m);
  assert.match(template, /^GEMINI_MODEL=gemini-3\.5-flash-lite$/m);
  assert.match(template, /^AI_PROVIDER=gemini$/m);
  assert.match(template, /^AI_PROJECT_RPM=$/m);
  assert.match(template, /^AI_PROJECT_RPD=$/m);
});
