import './support/noNetwork.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { AI_DISCLOSURE, computePayloadDigest, issueConsentToken, verifyConsentToken } from '../../src/ai/consent.ts';
import { assessPrivacy, containsCredential } from '../../src/ai/privacy.ts';
import { parseConsentBody, parseGenerationBody, type AiGenerationRequest } from '../../src/ai/validation.ts';
import { testConfig } from './support/aiFixtures.ts';

const ok = (body: unknown, max = 8_000) => {
  const parsed = parseGenerationBody(body, max);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.value;
};
const refused = (body: unknown, max = 8_000) => {
  const parsed = parseGenerationBody(body, max);
  assert.ok(!parsed.ok, JSON.stringify(body));
  return parsed;
};

describe('generation request parsing', () => {
  test('accepts each task with exactly its own options', () => {
    assert.deepEqual(ok({ request: { task: 'chat', input: 'Hello' }, consentToken: 'v1.abc.def' }),
      { request: { task: 'chat', input: 'Hello' }, consentToken: 'v1.abc.def' });
    assert.deepEqual(ok({ request: { task: 'rewrite', input: 'Send notes.', tone: 'Concise' } }).request,
      { task: 'rewrite', input: 'Send notes.', tone: 'Concise' });
    assert.deepEqual(ok({ request: { task: 'translate', input: 'Hello', targetLanguage: 'Vietnamese' } }).request,
      { task: 'translate', input: 'Hello', targetLanguage: 'Vietnamese' });
    for (const task of ['summarize', 'action_items', 'explain']) assert.equal(ok({ request: { task, input: 'Text\twith\r\nlines' } }).request.task, task);
    assert.equal(ok({ request: { task: 'chat', input: 'Hi' } }).consentToken, null);
  });

  test('rejects unknown keys, including identity, model, provider and demo claims', () => {
    for (const extra of [{ userId: 'u2' }, { model: 'gemini-3.5-pro' }, { provider: 'openai' }, { isDemo: true }, { temperature: 2 }, { history: [] }]) {
      assert.equal(refused({ request: { task: 'chat', input: 'Hi', ...extra } }).reason, 'request_shape');
      assert.equal(refused({ request: { task: 'chat', input: 'Hi' }, ...extra }).reason, 'body_shape');
    }
    assert.equal(refused(JSON.parse('{"request":{"task":"chat","input":"Hi","__proto__":{"x":1}}}')).reason, 'request_shape');
    for (const body of [null, [], 'text', { request: null }, { request: [] }]) refused(body);
  });

  test('rejects invalid tasks, options and text', () => {
    const cases: Array<[unknown, string]> = [
      [{ task: 'translate_all', input: 'x' }, 'task'],
      [{ task: 'chat', input: '' }, 'input_empty'],
      [{ task: 'chat', input: ' \n\t' }, 'input_empty'],
      [{ task: 'chat', input: 42 }, 'input_empty'],
      [{ task: 'chat', input: 'bad\u0000text' }, 'input_characters'],
      [{ task: 'chat', input: 'bell\u0007' }, 'input_characters'],
      [{ task: 'chat', input: 'del\u007f' }, 'input_characters'],
      [{ task: 'chat', input: 'lone \ud800 surrogate' }, 'input_characters'],
      [{ task: 'rewrite', input: 'x' }, 'tone'],
      [{ task: 'rewrite', input: 'x', tone: 'Sarcastic' }, 'tone'],
      [{ task: 'chat', input: 'x', tone: 'Friendly' }, 'tone_unexpected'],
      [{ task: 'translate', input: 'x', targetLanguage: 'German' }, 'language'],
      [{ task: 'summarize', input: 'x', targetLanguage: 'French' }, 'language_unexpected'],
      [{ task: 'chat', input: 'x', conversationId: 'has space' }, 'conversation_id'],
    ];
    for (const [request, reason] of cases) assert.equal(refused({ request }).reason, reason, JSON.stringify(request));
    assert.equal(refused({ request: { task: 'chat', input: 'x' }, consentToken: 7 }).reason, 'consent_token');
    assert.equal(ok({ request: { task: 'chat', input: 'emoji 🙂 and 日本語' } }).request.input, 'emoji 🙂 and 日本語');
  });

  test('reports oversized input separately, using the configured limit', () => {
    assert.deepEqual(refused({ request: { task: 'chat', input: 'x'.repeat(8_001) } }), { ok: false, code: 'AI_INPUT_TOO_LARGE', reason: 'input_length' });
    assert.equal(ok({ request: { task: 'chat', input: 'x'.repeat(8_000) } }).request.input.length, 8_000);
    assert.equal(refused({ request: { task: 'chat', input: 'x'.repeat(101) } }, 100).code, 'AI_INPUT_TOO_LARGE');
  });

  test('consent bodies need a version and a 43-character digest', () => {
    assert.deepEqual(parseConsentBody({ disclosureVersion: AI_DISCLOSURE.version, payloadDigest: 'a'.repeat(43) }),
      { ok: true, value: { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: 'a'.repeat(43) } });
    for (const body of [{}, { disclosureVersion: 'v', payloadDigest: 'a'.repeat(42) }, { disclosureVersion: 'V 1', payloadDigest: 'a'.repeat(43) },
      { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: 'a'.repeat(43), input: 'x' }, { disclosureVersion: AI_DISCLOSURE.version, payloadDigest: `${'a'.repeat(42)}=` }]) {
      assert.equal(parseConsentBody(body).ok, false, JSON.stringify(body));
    }
  });
});

describe('privacy rules', () => {
  test('refuses every Messenger handoff, whatever the client claims', () => {
    assert.deepEqual(assessPrivacy({ task: 'summarize', input: 'Hello', conversationId: 'securebot-demo' }), { allowed: false, reason: 'messenger_context' });
    assert.deepEqual(assessPrivacy({ task: 'rewrite', input: 'Draft', tone: 'Friendly', conversationId: 'conversation-1' }), { allowed: false, reason: 'messenger_context' });
    assert.deepEqual(assessPrivacy({ task: 'chat', input: 'What can @Secu do?' }), { allowed: true });
  });

  test('refuses common credential formats', () => {
    const samples = [
      '-----BEGIN PRIVATE KEY-----\nMIIE', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      `key AIza${'A'.repeat(35)}`, `AQ.Ab${'c'.repeat(48)}`, 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE',
      `ghp_${'a'.repeat(36)}`, `github_pat_${'b'.repeat(40)}`, 'xoxb-123456789012-abcdefghij', `sk_live_${'d'.repeat(24)}`,
      `sk-proj-${'e'.repeat(40)}`, `Authorization: Bearer ${'f'.repeat(32)}`, `Basic ${'Zm9vOmJhcg'.repeat(3)}==`,
      'password=hunter2', 'PASSWORD: Tr0ub4dor&3', 'my pwd = "abc"', 'passphrase: correct-horse-9', 'Cookie: secubuzz_session=abc123',
      '{"version":1,"algorithm":"AES-256-GCM","encoding":"base64","iv":"AAAA","ciphertext":"BBBB"}',
      `{"kty":"EC","crv":"P-256","d":"${'g'.repeat(43)}"}`,
    ];
    for (const sample of samples) assert.equal(containsCredential(sample), true, sample);
    assert.deepEqual(assessPrivacy({ task: 'explain', input: samples[0]! }), { allowed: false, reason: 'credential' });
  });

  test('allows ordinary text about security topics', () => {
    const samples = [
      'Two-factor authentication adds another step when you sign in.', 'What makes a good password?',
      'Please reset your password: click the link in the email.', 'Let’s meet on Friday at 10 AM to review the launch checklist.',
      'The task-list has eighteen items.', 'Use a basic plan for now.', 'Bearer bonds were common in the past.',
      'The "algorithm" field names AES-256-GCM in the docs.', 'Ask the desk about the AKIA prefix.',
    ];
    for (const sample of samples) assert.equal(containsCredential(sample), false, sample);
  });

  test('stays fast on adversarial input', () => {
    const started = performance.now();
    for (const input of ['password:'.repeat(800), `${'a'.repeat(7_990)}eyJ.`, `${'-'.repeat(8_000)}`, `"kty":${' '.repeat(7_990)}`]) containsCredential(input);
    assert.ok(performance.now() - started < 500);
  });
});

describe('consent tokens', () => {
  const config = testConfig();
  const other = testConfig({ AI_CONSENT_SECRET: 'another-test-only-consent-secret-0123456789' });
  const request: AiGenerationRequest = { task: 'rewrite', input: 'Send me the notes when you can.', tone: 'Professional' };
  const digest = computePayloadDigest(request);
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const issue = (overrides: Partial<{ sessionId: string; payloadDigest: string; nowMs: number }> = {}) =>
    issueConsentToken(config, { sessionId: 'session-1', payloadDigest: digest, nowMs: now, ...overrides }).token;
  const verify = (token: string, overrides: Partial<{ sessionId: string; payloadDigest: string; nowMs: number }> = {}, signer = config) =>
    verifyConsentToken(signer, token, { sessionId: 'session-1', payloadDigest: digest, nowMs: now + 1_000, ...overrides });

  test('the payload digest is SHA-256 over a fixed JSON array of raw strings', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(['secubuzz-ai-consent-v1', 'rewrite', 'Send me the notes when you can.', 'Professional', null, null]), 'utf8')
      .digest('base64url');
    assert.equal(digest, expected);
    assert.equal(digest.length, 43);
    assert.notEqual(computePayloadDigest({ ...request, tone: 'Friendly' }), digest);
    assert.notEqual(computePayloadDigest({ task: 'chat', input: 'e\u0301' }), computePayloadDigest({ task: 'chat', input: '\u00e9' }));
  });

  test('a fresh token verifies once for the same session, payload and disclosure', () => {
    const token = issue();
    assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const result = verify(token);
    assert.ok(result.ok);
    assert.equal(result.expiresAtMs, Math.floor(now / 1000) * 1000 + 60_000);
    assert.match(result.nonce, /^[A-Za-z0-9_-]{22}$/);
    const second = verify(issue());
    assert.ok(second.ok && second.nonce !== result.nonce, 'each token carries its own nonce');
  });

  test('rejects tokens bound to another session, payload, secret or disclosure', () => {
    const token = issue();
    assert.deepEqual(verify(token, { sessionId: 'session-2' }), { ok: false, reason: 'consent_session' });
    assert.deepEqual(verify(token, { payloadDigest: computePayloadDigest({ ...request, input: 'Different text' }) }), { ok: false, reason: 'consent_payload_mismatch' });
    assert.deepEqual(verify(token, {}, other), { ok: false, reason: 'consent_signature' });
    const [, payload] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...decoded, dv: 'older-version' })).toString('base64url');
    const resigned = `v1.${forged}.${config.consentMac(`secubuzz-ai-consent-v1.${forged}`).toString('base64url')}`;
    assert.deepEqual(verify(resigned), { ok: false, reason: 'consent_disclosure' });
  });

  test('rejects expired, future-dated and over-long tokens', () => {
    assert.deepEqual(verify(issue(), { nowMs: now + 60_000 }), { ok: false, reason: 'consent_expired' });
    assert.equal(verify(issue(), { nowMs: now + 59_000 }).ok, true);
    assert.deepEqual(verify(issue({ nowMs: now + 60_000 })), { ok: false, reason: 'consent_time' });
    const [, payload] = issue().split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const longer = Buffer.from(JSON.stringify({ ...decoded, exp: decoded.exp + 3_600 })).toString('base64url');
    const resigned = `v1.${longer}.${config.consentMac(`secubuzz-ai-consent-v1.${longer}`).toString('base64url')}`;
    assert.deepEqual(verify(resigned), { ok: false, reason: 'consent_time' });
  });

  test('rejects malformed and tampered tokens without throwing', () => {
    const token = issue();
    const [, payload, mac] = token.split('.') as [string, string, string];
    const flipped = `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
    for (const candidate of ['', 'v1', 'v2.abc.def', `v1.${payload}.${flipped}`, `v1.${payload}x.${mac}`, `${token}.extra`, token.toUpperCase()]) {
      const result = verify(candidate);
      assert.equal(result.ok, false, candidate);
    }
    const junk = Buffer.from('not json').toString('base64url').padEnd(16, 'A');
    assert.deepEqual(verify(`v1.${junk}.${config.consentMac(`secubuzz-ai-consent-v1.${junk}`).toString('base64url')}`), { ok: false, reason: 'consent_payload' });
  });
});
