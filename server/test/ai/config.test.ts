import './support/noNetwork.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, test } from 'node:test';
import { AI_LIMIT_DEFAULTS, AiConfigError, loadAiConfig } from '../../src/ai/config.ts';
import { describeAiConfig } from '../../src/ai/configReport.ts';
import { aiEnv, TEST_CONSENT_SECRET, TEST_GEMINI_KEY } from './support/aiFixtures.ts';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The committed template values (server/.env.example), with no key. */
const templateEnv = { GEMINI_API_KEY: '', GEMINI_MODEL: 'gemini-3.5-flash-lite', AI_PROVIDER: 'gemini', AI_REMOTE_ENABLED: 'false' };

describe('loadAiConfig', () => {
  test('the committed template loads disabled, holds no key and calls nothing', () => {
    const config = loadAiConfig(templateEnv);
    assert.equal(config.enabled, false);
    assert.equal(config.model, 'gemini-3.5-flash-lite');
    assert.equal(config.provider, 'gemini');
    assert.equal(config.apiKeyConfigured, false);
    assert.equal(config.geminiApiKey(), null);
    assert.equal(config.limits.projectPerMinute, null);
    assert.equal(config.allowedOrigins.size, 0);
    assert.equal(config.consentSecretSource, 'ephemeral');
    assert.ok(Object.isFrozen(config) && Object.isFrozen(config.limits));
  });

  test('enables remote AI only for the exact value "true"', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '', undefined]) {
      const env = aiEnv({ AI_REMOTE_ENABLED: value });
      assert.equal(loadAiConfig(env).enabled, false, String(value));
    }
    assert.equal(loadAiConfig(aiEnv()).enabled, true);
  });

  test('applies documented defaults and keeps app policy separate from Google quotas', () => {
    const config = loadAiConfig(aiEnv({ AI_USER_RPM: undefined, AI_USER_RPD: undefined, AI_MAX_CONCURRENT: undefined }));
    assert.deepEqual(config.limits, {
      userPerMinute: AI_LIMIT_DEFAULTS.userPerMinute,
      userPerDay: AI_LIMIT_DEFAULTS.userPerDay,
      projectPerMinute: 50,
      projectPerDay: 500,
      maxConcurrent: AI_LIMIT_DEFAULTS.maxConcurrent,
      maxInputChars: 8_000,
      maxOutputTokens: 2_048,
    });
    assert.equal(config.timeoutMs, 12_000);
    assert.equal(config.quotaScope, 'default');
    assert.equal(config.sessionCookieName, 'secubuzz_session');
    assert.deepEqual([...config.allowedOrigins], ['http://localhost:3000']);
    assert.equal(config.consentSecretSource, 'configured');
  });

  test('rejects other providers and models, and never switches models', () => {
    for (const AI_PROVIDER of ['openai', 'bedrock', 'Gemini', 'gemini ']) {
      assert.throws(() => loadAiConfig(aiEnv({ AI_PROVIDER })), AiConfigError, AI_PROVIDER);
      assert.throws(() => loadAiConfig({ ...templateEnv, AI_PROVIDER }), AiConfigError, `${AI_PROVIDER} while disabled`);
    }
    for (const GEMINI_MODEL of ['gemini-2.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-pro', 'models/gemini-3.5-flash-lite', 'GEMINI-3.5-FLASH-LITE']) {
      assert.throws(() => loadAiConfig(aiEnv({ GEMINI_MODEL })), /GEMINI_MODEL must be gemini-3\.5-flash-lite/, GEMINI_MODEL);
    }
    assert.throws(() => loadAiConfig(aiEnv({ GEMINI_MODEL: undefined })), /GEMINI_MODEL is required/);
    assert.throws(() => loadAiConfig(aiEnv({ AI_PROVIDER: undefined })), /AI_PROVIDER=gemini is required/);
  });

  test('requires a usable key when enabled and never reveals it in errors', () => {
    for (const GEMINI_API_KEY of [undefined, '', 'short', 'has whitespace in-the-key-0123456789', `x${'y'.repeat(512)}`, 'tab\tseparated-key-value-0123456789']) {
      assert.throws(() => loadAiConfig(aiEnv({ GEMINI_API_KEY })), (error: unknown) => {
        assert.ok(error instanceof AiConfigError);
        assert.match(error.message, /GEMINI_API_KEY must be set/);
        if (GEMINI_API_KEY) assert.ok(!error.message.includes(GEMINI_API_KEY));
        return true;
      });
    }
    assert.doesNotThrow(() => loadAiConfig({ ...templateEnv }));
  });

  test('requires the project quota figures from AI Studio and supplies no defaults for them', () => {
    assert.throws(() => loadAiConfig(aiEnv({ AI_PROJECT_RPM: undefined })), /AI_PROJECT_RPM and AI_PROJECT_RPD are required/);
    assert.throws(() => loadAiConfig(aiEnv({ AI_PROJECT_RPD: '' })), /AI_PROJECT_RPM and AI_PROJECT_RPD are required/);
    const disabled = loadAiConfig({ ...templateEnv, AI_PROJECT_RPM: '7' });
    assert.equal(disabled.limits.projectPerMinute, 7);
    assert.equal(disabled.limits.projectPerDay, null);
  });

  test('validates every numeric setting range', () => {
    const invalid: Array<[string, string]> = [
      ['AI_PROJECT_RPM', '0'], ['AI_PROJECT_RPM', '-1'], ['AI_PROJECT_RPM', '1.5'], ['AI_PROJECT_RPM', 'ten'], ['AI_PROJECT_RPD', '100001'],
      ['AI_USER_RPM', '0'], ['AI_USER_RPD', '0'], ['AI_MAX_CONCURRENT', '0'], ['AI_MAX_CONCURRENT', '101'],
      ['AI_MAX_INPUT_CHARS', '0'], ['AI_MAX_INPUT_CHARS', '8001'], ['AI_MAX_OUTPUT_TOKENS', '255'], ['AI_MAX_OUTPUT_TOKENS', '3001'],
      ['AI_TIMEOUT_MS', '999'], ['AI_TIMEOUT_MS', '15000'], ['AI_TIMEOUT_MS', ' 12000'],
    ];
    for (const [name, value] of invalid) assert.throws(() => loadAiConfig(aiEnv({ [name]: value })), AiConfigError, `${name}=${value}`);
    const tuned = loadAiConfig(aiEnv({ AI_MAX_INPUT_CHARS: '500', AI_MAX_OUTPUT_TOKENS: '256', AI_TIMEOUT_MS: '14000' }));
    assert.equal(tuned.limits.maxInputChars, 500);
    assert.equal(tuned.limits.maxOutputTokens, 256);
    assert.equal(tuned.timeoutMs, 14_000);
  });

  test('validates scope, origins and cookie name', () => {
    for (const AI_QUOTA_SCOPE of ['has space', 'a/b', 'x'.repeat(65)]) assert.throws(() => loadAiConfig(aiEnv({ AI_QUOTA_SCOPE })), AiConfigError);
    for (const AI_ALLOWED_ORIGINS of ['*', 'https://*.example.com', 'http://example.com', 'https://app.example.com/path', 'null']) {
      assert.throws(() => loadAiConfig(aiEnv({ AI_ALLOWED_ORIGINS })), /AI_ALLOWED_ORIGINS/, AI_ALLOWED_ORIGINS);
    }
    const origins = loadAiConfig(aiEnv({ AI_ALLOWED_ORIGINS: 'https://App.Example.com, http://127.0.0.1:3000' }));
    assert.deepEqual([...origins.allowedOrigins], ['https://app.example.com', 'http://127.0.0.1:3000']);
    assert.throws(() => loadAiConfig(aiEnv({ AI_SESSION_COOKIE: 'bad name' })), AiConfigError);
    assert.equal(loadAiConfig(aiEnv({ AI_SESSION_COOKIE: '__Host-secubuzz' })).sessionCookieName, '__Host-secubuzz');
  });

  test('refuses Gemini settings in NEXT_PUBLIC_* variables, even while disabled', () => {
    assert.throws(() => loadAiConfig({ ...templateEnv, NEXT_PUBLIC_GEMINI_API_KEY: '' }), /NEXT_PUBLIC_/);
    assert.throws(() => loadAiConfig({ ...templateEnv, NEXT_PUBLIC_GEMINI_MODEL: 'gemini-3.5-flash-lite' }), /NEXT_PUBLIC_/);
    assert.throws(() => loadAiConfig(aiEnv({ NEXT_PUBLIC_AI_KEY: TEST_GEMINI_KEY })), (error: unknown) =>
      error instanceof AiConfigError && /holds the Gemini API key/.test(error.message) && !error.message.includes(TEST_GEMINI_KEY));
    assert.doesNotThrow(() => loadAiConfig(aiEnv({ NEXT_PUBLIC_AI_REMOTE_READY: 'true', NEXT_PUBLIC_AUTH_MODE: 'api' })));
  });

  test('allows the memory quota store only outside production', () => {
    assert.equal(loadAiConfig(aiEnv({ AI_LOCAL_DEV_MEMORY_QUOTA: 'true' })).localDevMemoryQuota, true);
    assert.equal(loadAiConfig(aiEnv({ AI_LOCAL_DEV_MEMORY_QUOTA: 'TRUE' })).localDevMemoryQuota, false);
    assert.throws(() => loadAiConfig(aiEnv({ AI_LOCAL_DEV_MEMORY_QUOTA: 'true', NODE_ENV: 'production' })), /local development only/);
    assert.throws(() => loadAiConfig({ ...templateEnv, AI_LOCAL_DEV_MEMORY_QUOTA: 'true', NODE_ENV: 'production' }), /local development only/);
  });

  test('requires a shared consent secret in production and validates its length', () => {
    assert.throws(() => loadAiConfig(aiEnv({ AI_CONSENT_SECRET: undefined, NODE_ENV: 'production' })), /AI_CONSENT_SECRET is required/);
    assert.equal(loadAiConfig(aiEnv({ AI_CONSENT_SECRET: undefined })).consentSecretSource, 'ephemeral');
    assert.throws(() => loadAiConfig(aiEnv({ AI_CONSENT_SECRET: 'too-short' })), /AI_CONSENT_SECRET must be/);
    assert.equal(loadAiConfig(aiEnv({ NODE_ENV: 'production' })).production, true);
  });

  test('refuses disabled certificate verification when enabled', () => {
    assert.throws(() => loadAiConfig(aiEnv({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })), /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assert.doesNotThrow(() => loadAiConfig(aiEnv({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })));
  });

  test('keeps the key and consent secret out of serialization and inspection', () => {
    const config = loadAiConfig(aiEnv());
    assert.equal(config.geminiApiKey(), TEST_GEMINI_KEY);
    for (const text of [JSON.stringify(config), inspect(config, { depth: 5, showHidden: true }), String(config)]) {
      assert.ok(!text.includes(TEST_GEMINI_KEY), text);
      assert.ok(!text.includes(TEST_CONSENT_SECRET), text);
    }
    assert.equal(JSON.parse(JSON.stringify(config)).apiKeyConfigured, true);
    assert.equal(config.consentMac('data').length, 32);
  });
});

describe('ai:check-config report', () => {
  test('reports the disabled template without the key, its length or prefix', () => {
    const env = { ...templateEnv, GEMINI_API_KEY: 'AQ.Ab-fake-test-key-material-that-must-not-print-000' };
    const report = describeAiConfig(env, { envFileFound: true, useSystemCa: false });
    const text = report.lines.join('\n');
    assert.equal(report.ok, true);
    assert.equal(report.enabled, false);
    assert.match(text, /AI_REMOTE_ENABLED: false \(remote AI off\)/);
    assert.match(text, /GEMINI_MODEL: gemini-3\.5-flash-lite/);
    assert.match(text, /GEMINI_API_KEY: present \(value not shown\)/);
    assert.match(text, /AI_PROJECT_RPM: unset/);
    assert.match(text, /no Gemini request can be made/);
    assert.match(text, /--use-system-ca/);
    assert.ok(!text.includes('AQ.'), 'key prefix printed');
    assert.ok(!text.includes('fake-test-key'), 'key printed');
    assert.ok(!/\b52\b|\b53\b/.test(text), 'key length printed');
  });

  test('reports invalid settings with fixed messages and hides unsupported values', () => {
    const report = describeAiConfig({ ...templateEnv, GEMINI_MODEL: 'secret-looking-model-name' }, { envFileFound: false, useSystemCa: true });
    const text = report.lines.join('\n');
    assert.equal(report.ok, false);
    assert.match(text, /GEMINI_MODEL: unsupported value \(not shown\)/);
    assert.match(text, /Result: INVALID/);
    assert.ok(!text.includes('secret-looking-model-name'));
    assert.match(describeAiConfig({ AI_REMOTE_ENABLED: 'yes' }, { envFileFound: false, useSystemCa: true }).lines.join('\n'), /unrecognized value \(treated as off\)/);
  });

  test('the script prints the report, exits 1 on invalid settings and contacts nothing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'secubuzz-ai-config-'));
    try {
      const script = join(serverRoot, 'src', 'ai', 'checkConfig.ts');
      const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
        encoding: 'utf8',
      });
      const valid = run({ ...templateEnv, GEMINI_API_KEY: TEST_GEMINI_KEY });
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /server\/\.env: not found/);
      assert.match(valid.stdout, /Result: valid/);
      assert.ok(!valid.stdout.includes(TEST_GEMINI_KEY) && !valid.stderr.includes(TEST_GEMINI_KEY));
      const invalid = run({ ...templateEnv, GEMINI_MODEL: 'gemini-2.5-flash-lite' });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stdout, /Result: INVALID/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
