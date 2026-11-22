/** Phase 12A negative probes. Deliberately excluded from *.test.ts regression discovery.
 * These assertions express the required protection and currently FAIL; see the team review.
 * Real DATA sessions and production client crypto; only the final server read is replayed.
 * Run: node --test --test-concurrency=1 test/manual/revision-watermark-review.check.ts
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { DataStack } from '../data/support/stack.ts';

createRequire(new URL('../../../client/package.json', import.meta.url))('fake-indexeddb/auto');
let stack: DataStack, Session: any, HttpAuth: any, Pins: any;
const sessions: any[] = [], apis: any[] = [];
before(async () => {
  stack = await DataStack.start();
  const options = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../../../client/tsconfig.json', import.meta.url)) };
  Session = (await tsImport('../../../client/src/security/e2ee/session.ts', options)).SecureMessagingSession;
  HttpAuth = (await tsImport('../../../client/src/auth/httpAuthService.ts', options)).HttpAuthService;
  Pins = (await tsImport('../../../client/src/messaging/authenticatedPins.ts', options)).AuthenticatedPins;
});
after(async () => { for (const s of sessions) s.dispose(); for (const a of apis) a.dispose(); await stack?.close(); });

async function pair(label: string) {
  const a = await stack.person(label + '-a', 'Alice'), b = await stack.person(label + '-b', 'Bob');
  await stack.befriend(a, b);
  const cid = await stack.openDm(a, b), clients = [];
  for (const person of [a, b]) {
    const headers = { Origin: 'http://localhost:3000', Cookie: [...person.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    const auth = new HttpAuth({ fetch: (path: string, options: RequestInit) => fetch(stack.url + path, { ...options, headers: { ...options.headers, ...headers } }) });
    const api = auth.createSessionApi((await person.browser.request('/api/auth/me')).body.user); apis.push(api);
    const session = new Session(api); sessions.push(session); await session.initialize(true); clients.push({ session, api });
  }
  await clients[0]!.session.prepare(cid); await clients[1]!.session.prepare(cid);
  return { a: clients[0]!, b: clients[1]!, cid };
}

for (const [i, mode] of ['pin-edit', 'pin-unsend', 'rebind-edit', 'rebind-unsend'].entries()) {
  test(`known defect: ${mode} must not expose an original after a newer account watermark`, async () => {
    const { a, b, cid } = await pair('wm' + i);
    const m = await a.session.send(cid, 'Alice', 'ORIGINAL_REVIEW_FIXTURE');
    let pins: any, replay = false;
    const isPin = mode.startsWith('pin');
    try {
      let viewer: any;
      if (isPin) {
        await a.api.request(`/api/messages/${m.storageId}/pin`, { method: 'POST', body: { pinned: true, expectedVersion: 0, operationId: crypto.randomUUID() } });
        const oldCollection = await b.api.request(`/api/conversations/${cid}/pins`);
        viewer = new Session({ ...b.api, request: (path: string, options: any) => replay && path === `/api/conversations/${cid}/pins`
          ? Promise.resolve(structuredClone(oldCollection)) : b.api.request(path, options) }); sessions.push(viewer);
        pins = new Pins(viewer); pins.authorize([await viewer.api.getConversation(cid)]); await pins.refresh(cid);
        assert.equal(pins.getSnapshot().rows[cid][0].text, 'ORIGINAL_REVIEW_FIXTURE');
      }
      await a.session.editMessage(m, 'EDITED_REVIEW_FIXTURE');
      assert.equal((await b.session.history(cid)).items[0].text, 'EDITED_REVIEW_FIXTURE');
      if (mode.endsWith('unsend')) {
        await a.session.api.remove(m.storageId);
        assert.equal((await b.session.history(cid)).items[0].message.state, 'deleted');
      }
      await assert.rejects(b.session.decryptStoredMessage(m), (error: any) => error.code === 'invalid_proof');
      if (isPin) {
        replay = true; await pins.refresh(cid, true);
        assert.equal(pins.getSnapshot().rows[cid][0]?.text ?? null, null, 'Cached pin must consult the current persisted watermark');
      } else {
        const replaySession = new Session({ ...b.api, request: (path: string, options: any) => path.includes('/messages?')
          ? Promise.resolve({ items: [{ ...m, storageId: 'different-storage-id-' + i }], nextCursor: null }) : b.api.request(path, options) }); sessions.push(replaySession);
        assert.equal((await replaySession.history(cid)).items[0].text, null, 'Logical wire identity must retain its watermark across server storage ID changes');
      }
    } finally { pins?.dispose(); }
  });
}
