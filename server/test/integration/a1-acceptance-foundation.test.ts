/** Stage 1 only: existing runtime controls plus explicit unimplemented format-2 TODOs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { editStatement, editProofStatement, revisionEnvelopeStatement, type EditProof } from '../../../shared/messageRevisions.ts';
import type { EnvelopeV2Like } from '../e2ee/support/deviceClient.ts';
import { A1ClientFixture, invalidProof, wireOf, type A1Message, type A1Row, type RequestInterceptor } from '../support/a1-client-fixture.ts';
import { a1Cases, foundationChecks, foundationTitle } from '../support/a1-catalog.ts';

let fixture: A1ClientFixture;
before(async () => { fixture = await A1ClientFixture.start(); });
after(async () => { await fixture?.close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Head { revision: number; hash: string; deleted: boolean }
const code = (error: unknown, expected: string) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const design = readFileSync(new URL('../../../docs/a1-rollback-protection-design.md', import.meta.url), 'utf8');
const planned = [...design.matchAll(/^\| ([AMSCFR]\d{2}) \| ([^|]+) \|/gm)].map(match => ({ id: match[1]!, title: match[2]!.trim() }));

test('[T01][traceability] the 37 pending scenarios and all ten invariants are explicitly catalogued', () => {
  assert.equal(planned.length, 37); assert.equal(new Set(planned.map(row => row.id)).size, 37);
  assert.deepEqual(a1Cases.map(([id]) => id), planned.map(row => row.id));
  const invariants = new Set(a1Cases.flatMap(([, ids]) => ids.split(',')));
  assert.deepEqual([...invariants].sort(), ['I1', 'I10', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
  assert.equal(new Set(foundationChecks.map(row => row.id)).size, foundationChecks.length);
  for (const row of foundationChecks) {
    for (const id of row.cases) assert(planned.some(candidate => candidate.id === id));
    for (const id of row.invariants) assert(invariants.has(id));
  }
});

test(foundationTitle('P01'), async () => {
  const { a, b, cid } = await fixture.pair('p01');
  const original = await a.session.send(cid, 'Alice', 'ORIGINAL_P01');
  assert.equal((await b.session.history(cid)).items[0]!.text, 'ORIGINAL_P01');
  await a.session.editMessage(original, 'EDITED_P01\nUnicode: \u{1f1fb}\u{1f1f3}');
  const latest = (await b.session.history(cid)).items[0]!;
  assert.equal(latest.text, 'EDITED_P01\nUnicode: \u{1f1fb}\u{1f1f3}');
  const restored = await fixture.reopen(b);
  await assert.rejects(restored.session.decryptStoredMessage(original), invalidProof);
  assert.equal((await restored.session.decryptStoredMessage(latest.message)).text, latest.text);
  assert.equal(latest.message.id, original.id); assert.equal(latest.message.storageId, original.storageId);
});

test(foundationTitle('P02'), async () => {
  const { a, b, cid } = await fixture.pair('p02'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_P02');
  await a.session.editMessage(original, 'EDITED_P02'); const edited = (await b.session.history(cid)).items[0]!;
  const beforeHead = await b.session.store.get<Head>('message-revision', original.storageId); assert(beforeHead);
  await a.session.api.remove(original.storageId);
  assert.equal((await b.session.history(cid)).items[0]!.message.state, 'deleted');
  assert.deepEqual(await b.session.store.get('message-revision', original.storageId), { ...beforeHead, deleted: true });
  const restored = await fixture.reopen(b);
  await assert.rejects(restored.session.decryptStoredMessage(original), invalidProof);
  await assert.rejects(restored.session.decryptStoredMessage(edited.message), invalidProof);
  assert.deepEqual(await restored.session.store.get('message-revision', original.storageId), { ...beforeHead, deleted: true });
});

test(foundationTitle('P03'), async () => {
  const { a, b, cid } = await fixture.pair('p03'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_P03');
  await a.session.editMessage(original, 'EDITED_P03'); const latest = (await b.session.history(cid)).items[0]!;
  const expected = await b.session.store.get('message-revision', original.storageId);
  const first = await fixture.reopen(b), second = await fixture.reopen(b);
  const [old, current] = await Promise.allSettled([first.session.decryptStoredMessage(original), second.session.decryptStoredMessage(latest.message)]);
  assert.equal(old.status, 'rejected'); if (old.status === 'rejected') assert(invalidProof(old.reason));
  assert.equal(current.status, 'fulfilled'); if (current.status === 'fulfilled') assert.equal(current.value.text, latest.text);
  assert.deepEqual(await b.session.store.get('message-revision', original.storageId), expected);
});

test(foundationTitle('P04'), async () => {
  for (const deletionFirst of [false, true]) {
    const { a, b, cid } = await fixture.pair(deletionFirst ? 'p04b' : 'p04a');
    const original = await a.session.send(cid, 'Alice', 'ORIGINAL_P04'); await b.session.history(cid);
    const edited = await a.session.editMessage(original, 'EDITED_P04');
    await a.session.api.remove(original.storageId);
    const active = await fixture.reopen(b), deleted = await fixture.reopen(b);
    const readActive = () => active.session.decryptStoredMessage(edited.message);
    const readDeleted = () => deleted.session.history(cid);
    const operations = deletionFirst ? [readDeleted(), readActive()] : [readActive(), readDeleted()];
    await Promise.allSettled(operations);
    const head = await b.session.store.get<Head>('message-revision', original.storageId); assert(head);
    assert.equal(head.deleted, true);
    const known = [hash(revisionEnvelopeStatement(wireOf(original))), hash(editProofStatement(edited.message.edit!.proofs[0]!.proof))];
    assert.equal(head.hash, known[head.revision]);
    await assert.rejects(active.session.decryptStoredMessage(edited.message), invalidProof);
  }
});

test(foundationTitle('P05'), async () => {
  const { a, b, cid } = await fixture.pair('p05');
  const first = await a.session.send(cid, 'Alice', 'FIRST_P05'); await b.session.history(cid);
  const expected = await b.session.store.get('message-revision', first.storageId);
  const second = await a.session.send(cid, 'Alice', 'SECOND_P05');
  assert.equal((await b.session.decryptStoredMessage(second)).text, 'SECOND_P05');
  await assert.rejects(b.session.decryptStoredMessage({ ...second, storageId: first.storageId }), invalidProof);
  assert.deepEqual(await b.session.store.get('message-revision', first.storageId), expected);
});

test(foundationTitle('P06'), async () => {
  const { a, b, extra, cid } = await fixture.pair('p06', true); assert(extra);
  const original = await a.session.send(cid, 'Alice', 'ORIGINAL_P06');
  interface EditRequest { proof: EditProof; envelope: EnvelopeV2Like }
  const captured: EditRequest[] = []; let release!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bothPrepared = new Promise<void>((resolve, reject) => {
    release = resolve; timer = setTimeout(() => reject(new Error('Both genuine sender devices must prepare their requests')), 10000); timer.unref();
  });
  const intercept: RequestInterceptor = async (path, options, next) => {
    if (path === `/api/messages/${original.storageId}` && options?.method === 'PATCH') {
      captured.push(structuredClone(options.body) as EditRequest);
      if (captured.length === 2) release(); await bothPrepared;
    }
    return next();
  };
  const first = await fixture.reopen(a, intercept), second = await fixture.reopen(extra, intercept);
  let results: PromiseSettledResult<A1Row>[];
  try { results = await Promise.allSettled([first.session.editMessage(original, 'BRANCH_A_P06'), second.session.editMessage(original, 'BRANCH_B_P06')]); }
  finally { if (timer) clearTimeout(timer); }
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert(rejected?.status === 'rejected' && code(rejected.reason, 'stale_state'));
  assert.equal(captured.length, 2);
  const winner = (await b.session.history(cid)).items[0]!;
  assert.equal(winner.message.edit!.proofs.length, 1);
  const losing = captured.find(request => request.proof.operationId !== winner.message.edit!.proofs[0]!.proof.operationId); assert(losing);
  const signer = (await a.session.api.ownDevices()).find(device => device.deviceKeyId === losing.proof.signerDeviceKeyId);
  assert(signer && typeof signer.signingPublicKey === 'string');
  // A real valid signature and decryptable AEAD distinguish this from a forged-proof test.
  await fixture.runtime.verifySignature(signer.signingPublicKey, editStatement(losing.proof), losing.proof.signature);
  const plaintext = await fixture.runtime.decryptV2((await b.session.prepare(cid)).key, losing.envelope);
  assert(plaintext.includes('BRANCH_A_P06') || plaintext.includes('BRANCH_B_P06'));
  const beforeHead = await b.session.store.get('message-revision', original.storageId);
  const fork: A1Message = { ...original, edit: { v: 1, proofs: [{ proof: losing.proof, signer }], envelope: losing.envelope } };
  await assert.rejects(b.session.decryptStoredMessage(fork), invalidProof);
  assert.deepEqual(await b.session.store.get('message-revision', original.storageId), beforeHead);
});

test(foundationTitle('P07'), async () => {
  const { a, b, cid } = await fixture.pair('p07'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_P07');
  await b.session.history(cid); const head = await b.session.store.get('message-revision', original.storageId);
  await assert.rejects(b.session.decryptStoredMessage({ ...original, id: original.id + '-changed' }), error => code(error, 'decryption_failed'));
  assert.deepEqual(await b.session.store.get('message-revision', original.storageId), head);
  assert.equal((await b.session.decryptStoredMessage(original)).text, 'ORIGINAL_P07');
});

test(foundationTitle('P08'), async () => {
  const { a, b, cid } = await fixture.pair('p08'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_P08');
  await a.session.api.remove(original.storageId); await b.session.history(cid);
  const empty = { revision: 0, hash: '', deleted: true };
  assert.deepEqual(await b.session.store.get('message-revision', original.storageId), empty);
  const restored = await fixture.reopen(b);
  await assert.rejects(restored.session.decryptStoredMessage(original), invalidProof);
  assert.deepEqual(await restored.session.store.get('message-revision', original.storageId), empty);
});

test(foundationTitle('P09'), async () => {
  const { a, b, cid } = await fixture.pair('p09'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_P09');
  assert.equal(a.databaseName, b.databaseName, 'Isolation must be account namespacing, not different databases');
  await b.session.history(cid);
  await a.session.store.observeRevision(original.storageId, [], true); // Synthetic local observation only; no server deletion.
  assert.equal((await b.session.decryptStoredMessage(original)).text, 'ORIGINAL_P09');
  assert.equal((await b.session.store.get<Head>('message-revision', original.storageId))!.deleted, false);
  assert.equal((await a.session.store.get<Head>('message-revision', original.storageId))!.deleted, true);
});

test(foundationTitle('P10'), async () => {
  const { a, b, cid } = await fixture.pair('p10'), original = await a.session.send(cid, 'Alice', 'ORIGINAL_P10');
  let request: unknown;
  const sender = await fixture.reopen(a, async (path, options, next) => {
    if (path === `/api/messages/${original.storageId}` && options?.method === 'PATCH') request = structuredClone(options.body);
    return next();
  });
  await sender.session.editMessage(original, 'EDITED_P10'); assert(request);
  await assert.rejects(b.api.request(`/api/messages/${original.storageId}`, { method: 'PATCH', body: request }), error => code(error, 'forbidden'));
  const missingCsrf = await a.person.browser.request(`/api/messages/${original.storageId}`, { method: 'PATCH', body: request });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await b.session.history(cid)).items[0]!.text, 'EDITED_P10');
});

test(foundationTitle('P11'), async () => {
  const { b, cid } = await fixture.pair('p11');
  const own = await b.session.send(cid, 'Bob', 'EXACT_PENDING_P11');
  interface Device { deviceId: string; deviceKeyId: string; signing: { privateKey: { extractable: boolean } }; agreement: { privateKey: { extractable: boolean } } }
  const beforeDevice = await b.session.store.get<Device>('device'); assert(beforeDevice);
  await b.session.store.reserveNonce('a1-preservation-sentinel', 'fixture-reserved-nonce');
  const bytes = wireOf(own); await b.session.store.put('pending', cid, bytes);
  b.session.dispose(); let posts = 0;
  const restored = await fixture.reopen(b, (path, options, next) => {
    if (path === `/api/conversations/${cid}/messages` && options?.method === 'POST') posts++;
    return next();
  });
  const afterDevice = await restored.session.store.get<Device>('device'); assert(afterDevice);
  assert.equal(afterDevice.deviceId, beforeDevice.deviceId); assert.equal(afterDevice.deviceKeyId, beforeDevice.deviceKeyId);
  assert.equal(afterDevice.signing.privateKey.extractable, false); assert.equal(afterDevice.agreement.privateKey.extractable, false);
  assert.equal(await restored.session.store.reserveNonce('a1-preservation-sentinel', 'fixture-reserved-nonce'), false);
  assert.deepEqual(await restored.session.pending(cid), bytes);
  assert.equal((await restored.session.retryPending(cid))!.storageId, own.storageId);
  assert.equal(await restored.session.pending(cid), null); assert.equal(posts, 0);
  assert.equal((await restored.session.history(cid)).items[0]!.text, 'EXACT_PENDING_P11');
});

// No callbacks/stubs: these are unimplemented acceptance contracts, not passing format-2 tests.
for (const [id, invariants] of a1Cases) {
  test.todo(`[PENDING format-2 ${id}][${invariants}] ${planned.find(row => row.id === id)!.title}; approvals and runtime implementation required`);
}
