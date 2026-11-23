/** Intentionally red A1 acceptance probe. No expected-failure wrapper; exit code must remain nonzero. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { A1ClientFixture, invalidProof, type A1Message } from '../support/a1-client-fixture.ts';
import type { EnvelopeV2Like } from '../e2ee/support/deviceClient.ts';
import { foundationTitle } from '../support/a1-catalog.ts';

let fixture: A1ClientFixture;
before(async () => { fixture = await A1ClientFixture.start(); });
after(async () => { await fixture?.close(); });

test(foundationTitle('E01'), async () => {
  const { a, b, cid } = await fixture.pair('e01'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_LOGICAL_E01');
  assert.equal((await b.session.history(cid)).items[0]!.text, 'ORIGINAL_LOGICAL_E01');
  let attempted: EnvelopeV2Like | undefined;
  const sender = await fixture.reopen(a, (path, options, next) => {
    if (path === `/api/conversations/${cid}/messages` && options?.method === 'POST') attempted = structuredClone(options.body) as EnvelopeV2Like;
    return next();
  });
  // The sender genuinely encrypts another attempt; DATA correctly refuses an overwrite.
  await assert.rejects(sender.session.send(cid, 'Alice', 'CONFLICTING_LOGICAL_E01', undefined, undefined, original.id),
    error => !!error && typeof error === 'object' && 'code' in error && error.code === 'idempotency_conflict');
  assert(attempted); assert.notEqual(attempted.encryption.ciphertext, original.encryption!.ciphertext);
  assert.equal(await fixture.runtime.decryptV2((await b.session.prepare(cid)).key, attempted), 'CONFLICTING_LOGICAL_E01');
  assert.equal((await b.session.history(cid)).items[0]!.text, 'ORIGINAL_LOGICAL_E01');
  const conflicting: A1Message = { ...original, ...attempted };
  await assert.rejects(b.session.decryptStoredMessage(conflicting), invalidProof);
  const replay = await fixture.replay(b, cid, { ...conflicting, storageId: 'different-storage-valid-original-e01' });
  const row = (await replay.session.history(cid)).items[0]!;
  assert.equal(row.text, null, 'The logical identity must retain its original fingerprint across alias substitution');
});
