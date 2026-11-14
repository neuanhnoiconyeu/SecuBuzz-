import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_LIMITS,
  DEFAULT_TIMING,
  loadStandaloneConfig,
  normalizeOrigin,
  RealtimeConfigError,
  resolveRealtimeConfig,
} from '../../src/realtime/config.ts';
import { silentLogger } from '../../src/realtime/logger.ts';

const base = { allowedOrigins: ['http://localhost:3000'], logger: silentLogger };

describe('allowed origins', () => {
  test('normalizes exact origins', () => {
    assert.equal(normalizeOrigin('https://App.Example.com'), 'https://app.example.com');
    assert.equal(normalizeOrigin('https://app.example.com/'), 'https://app.example.com');
    assert.equal(normalizeOrigin('https://app.example.com:8443'), 'https://app.example.com:8443');
    assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(normalizeOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    assert.equal(normalizeOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  });

  test('rejects wildcards, null, credentials, paths, queries, fragments and remote plain HTTP', () => {
    for (const origin of ['*', 'https://*.example.com', 'null', 'https://user:pass@example.com', 'https://example.com/app',
      'https://example.com?x=1', 'https://example.com#x', 'http://example.com', 'ws://localhost:3000', 'file:///tmp',
      ' https://example.com', 'example.com', '', 42]) {
      assert.throws(() => normalizeOrigin(origin), RealtimeConfigError, String(origin));
    }
  });
});

describe('resolveRealtimeConfig', () => {
  test('applies safe defaults and fail-closed adapters', () => {
    const config = resolveRealtimeConfig(base);
    assert.equal(config.path, '/socket.io');
    assert.equal(config.namespace, '/');
    assert.equal(config.sessionCookieName, 'secubuzz_session');
    assert.deepEqual([...config.allowedOrigins], ['http://localhost:3000']);
    assert.equal(config.sessionResolver, null);
    assert.equal(config.authorizer, null);
    assert.equal(config.messageStore, null);
    assert.equal(config.recipientKeyVerifier, null);
    assert.deepEqual(config.limits, DEFAULT_LIMITS);
    assert.deepEqual(config.timing, DEFAULT_TIMING);
    assert.ok(Object.isFrozen(config) && Object.isFrozen(config.limits));
  });

  test('keeps the presence refresh below the client 45 second freshness window', () => {
    assert.ok(DEFAULT_TIMING.presenceRefreshIntervalMs < 45_000);
    assert.throws(() => resolveRealtimeConfig({ ...base, timing: { presenceRefreshIntervalMs: 45_000 } }), RealtimeConfigError);
    assert.ok(resolveRealtimeConfig({ ...base, timing: { presenceRefreshIntervalMs: 40_000 } }));
  });

  test('keeps adapter deadlines below the client 5 s read and 10 s connect timeouts by default', () => {
    assert.ok(DEFAULT_TIMING.adapterTimeoutMs < 5_000);
    assert.ok(DEFAULT_TIMING.handshakeTimeoutMs < 10_000);
  });

  test('rejects invalid paths, namespaces and cookie names', () => {
    for (const path of ['socket.io', '//socket.io', '/socket.io/', '/a/../b', '/a b', '/socket.io?x']) {
      assert.throws(() => resolveRealtimeConfig({ ...base, path }), RealtimeConfigError, path);
    }
    for (const namespace of ['', 'realtime', '/a/b', '/a b']) {
      assert.throws(() => resolveRealtimeConfig({ ...base, namespace }), RealtimeConfigError, namespace);
    }
    for (const sessionCookieName of ['', 'bad name', 'semi;colon', 'quote"']) {
      assert.throws(() => resolveRealtimeConfig({ ...base, sessionCookieName }), RealtimeConfigError, sessionCookieName);
    }
    assert.equal(resolveRealtimeConfig({ ...base, sessionCookieName: '__Host-secubuzz' }).sessionCookieName, '__Host-secubuzz');
  });

  test('rejects out-of-range, non-integer and unknown limits and timing values', () => {
    assert.throws(() => resolveRealtimeConfig({ ...base, limits: { maxConnectionsPerUser: 0 } }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, limits: { maxPayloadBytes: 1.5 } as never }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, limits: { unknown: 1 } as never }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, limits: { maxCiphertextLength: 200_000, maxPayloadBytes: 131_072 } }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, timing: { adapterTimeoutMs: 5_000, handshakeTimeoutMs: 4_000 } }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, timing: { revalidationIntervalMs: 5 } }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, rates: { typing: { capacity: 0, refillPerSecond: 1 } } }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, rates: { typing: { capacity: 1, refillPerSecond: -1 } } }), RealtimeConfigError);
    assert.equal(resolveRealtimeConfig({ ...base, timing: { revalidationIntervalMs: 0 } }).timing.revalidationIntervalMs, 0);
  });

  test('rejects adapters without their required methods', () => {
    assert.throws(() => resolveRealtimeConfig({ ...base, sessionResolver: {} as never }), /sessionResolver.resolveSession/);
    assert.throws(() => resolveRealtimeConfig({ ...base, sessionResolver: { resolveSession: async () => ({ status: 'missing' }), checkSession: 1 } as never }),
      /sessionResolver.checkSession/);
    assert.throws(() => resolveRealtimeConfig({ ...base, authorizer: { listConversationIds: async () => [] } as never }), /authorizer/);
    assert.throws(() => resolveRealtimeConfig({ ...base, messageStore: { findMessage: async () => null } as never }), /messageStore/);
    assert.throws(() => resolveRealtimeConfig({ ...base, recipientKeyVerifier: {} as never }), /recipientKeyVerifier/);
    assert.throws(() => resolveRealtimeConfig({ ...base, securityPolicy: { evaluateEvent: 'allow' } as never }), /securityPolicy/);
    assert.throws(() => resolveRealtimeConfig({ ...base, logger: {} as never }), /logger/);
  });

  test('rejects missing or oversized origin lists', () => {
    assert.throws(() => resolveRealtimeConfig({ logger: silentLogger } as never), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...base, allowedOrigins: Array.from({ length: 65 }, (_, i) => `https://h${i}.example.com`) }), RealtimeConfigError);
    assert.equal(resolveRealtimeConfig({ ...base, allowedOrigins: [] }).allowedOrigins.size, 0);
  });
});

describe('loadStandaloneConfig', () => {
  test('maps environment variables without creating adapters', () => {
    const config = loadStandaloneConfig({
      REALTIME_HOST: '0.0.0.0', REALTIME_PORT: '6100', REALTIME_PATH: '/rt', REALTIME_NAMESPACE: '/realtime',
      REALTIME_ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:3000', REALTIME_SESSION_COOKIE: '__Host-sid',
    });
    assert.deepEqual(config, {
      host: '0.0.0.0', port: 6100,
      options: { allowedOrigins: ['https://app.example.com', 'http://localhost:3000'], path: '/rt', namespace: '/realtime', sessionCookieName: '__Host-sid' },
    });
  });

  test('defaults to loopback and no allowed origins', () => {
    assert.deepEqual(loadStandaloneConfig({}), { host: '127.0.0.1', port: 5100, options: { allowedOrigins: [] } });
  });

  test('rejects invalid ports and hosts', () => {
    for (const REALTIME_PORT of ['-1', '65536', 'http', '1.5']) assert.throws(() => loadStandaloneConfig({ REALTIME_PORT }), RealtimeConfigError);
    assert.throws(() => loadStandaloneConfig({ REALTIME_HOST: 'a b' }), RealtimeConfigError);
  });
});
