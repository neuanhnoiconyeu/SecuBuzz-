import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStack, type Person } from './support/stack.ts';

let stack: DataStack;
let avatarDirectory: string;
const conversationV2 = (path: string) => `${path}${path.includes('?') ? '&' : '?'}contractVersion=2`;

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const jpegBytes = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const webpBytes = Buffer.concat([Buffer.from('RIFF\x18\x00\x00\x00WEBP'), Buffer.alloc(16, 0x20)]);

const cookieHeaders = (p: Person) => ({
  Origin: 'http://localhost:3000',
  Cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
});

before(async () => {
  avatarDirectory = await mkdtemp(join(tmpdir(), 'secubuzz-avatars-'));
  stack = await DataStack.start({ dependencies: { socialOptions: { avatarDirectory } } });
});

after(async () => {
  await stack?.close();
  if (avatarDirectory) {
    for (const name of await readdir(avatarDirectory)) await unlink(join(avatarDirectory, name));
    await rmdir(avatarDirectory);
  }
});

function parseAvatarUploadResponse(value: unknown): { readonly profile: { readonly avatarUrl: string } } {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'upload response body must be an object');
  const profile = (value as Record<string, unknown>).profile;
  assert.ok(profile !== null && typeof profile === 'object' && !Array.isArray(profile), 'upload response profile must be an object');
  const avatarUrl = (profile as Record<string, unknown>).avatarUrl;
  if (typeof avatarUrl !== 'string') assert.fail('upload response profile.avatarUrl must be a string');
  return { profile: { avatarUrl } };
}

test('profile avatar upload, replacement, removal, validation, and authorization enforce account ownership', async () => {
  const { alice, bob } = await stack.pair('v25-avatar-a', 'v25-avatar-b');
  const outsider = await stack.person('v25-avatar-c');

  // Upload PNG avatar as Alice
  const upload1 = await fetch(`${stack.url}/api/users/me/avatar`, {
    method: 'POST',
    headers: { ...cookieHeaders(alice), 'X-CSRF-Token': alice.browser.token, 'Content-Type': 'image/png' },
    body: pngBytes,
  });
  assert.equal(upload1.status, 200);
  const body1 = parseAvatarUploadResponse(await upload1.json());
  assert.ok(body1.profile.avatarUrl.startsWith(`/api/users/${alice.id}/avatar?v=`));
  assert.equal((await readdir(avatarDirectory)).length, 1);

  // Friend (Bob) and Alice can fetch it; outsider gets 200 if unblocked? Wait: public profile allows active unblocked users.
  const fetched = await fetch(`${stack.url}${body1.profile.avatarUrl}`, { headers: cookieHeaders(bob) });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), pngBytes);

  // Replace with JPEG -> old file is deleted and URL changes
  const upload2 = await fetch(`${stack.url}/api/users/me/avatar`, {
    method: 'POST',
    headers: { ...cookieHeaders(alice), 'X-CSRF-Token': alice.browser.token, 'Content-Type': 'image/jpeg' },
    body: jpegBytes,
  });
  assert.equal(upload2.status, 200);
  const body2 = parseAvatarUploadResponse(await upload2.json());
  assert.notEqual(body2.profile.avatarUrl, body1.profile.avatarUrl);
  assert.equal((await readdir(avatarDirectory)).length, 1);

  // Replace with WebP
  const upload3 = await fetch(`${stack.url}/api/users/me/avatar`, {
    method: 'POST',
    headers: { ...cookieHeaders(alice), 'X-CSRF-Token': alice.browser.token, 'Content-Type': 'image/webp' },
    body: webpBytes,
  });
  assert.equal(upload3.status, 200);

  // Rejects SVG/script/invalid bytes, mismatched content-type, missing CSRF, and target-user route
  const svgAttempt = await fetch(`${stack.url}/api/users/me/avatar`, {
    method: 'POST',
    headers: { ...cookieHeaders(alice), 'X-CSRF-Token': alice.browser.token, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('<svg onload="alert(1)"></svg>'),
  });
  assert.equal(svgAttempt.status, 400);

  const noCsrf = await fetch(`${stack.url}/api/users/me/avatar`, {
    method: 'POST',
    headers: { ...cookieHeaders(alice), 'Content-Type': 'image/png' },
    body: pngBytes,
  });
  assert.equal(noCsrf.status, 403);

  const hijack = await bob.browser.mutate('PATCH', `/api/users/${alice.id}`, { displayName: 'Hijacked' });
  assert.equal(hijack.status, 404);

  // Blocking hides Alice's avatar from Bob
  assert.equal((await alice.browser.mutate('POST', '/api/blocks', { userId: bob.id })).status, 204);
  const blockedFetch = await fetch(`${stack.url}${body2.profile.avatarUrl}`, { headers: cookieHeaders(bob) });
  assert.equal(blockedFetch.status, 404);
  assert.equal((await alice.browser.mutate('DELETE', `/api/blocks/${bob.id}`)).status, 204);
  await stack.befriend(alice, bob);

  // Remove avatar -> falls back to initials/preset and deletes file
  const removed = await alice.browser.mutate('DELETE', '/api/users/me/avatar');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.profile.avatarUrl, undefined);
  assert.equal((await readdir(avatarDirectory)).length, 0);
  const afterRemove = await fetch(`${stack.url}/api/users/${alice.id}/avatar`, { headers: cookieHeaders(outsider) });
  assert.equal(afterRemove.status, 404);
});

test('conversation nicknames and themes persist, synchronize across both accounts, keep security identities unchanged, and enforce authorization', async () => {
  const { alice, bob, conversationId } = await stack.pair('v25-pref-a', 'v25-pref-b');
  const outsider = await stack.person('v25-pref-outsider');

  // Default state
  const initial = await alice.browser.request(conversationV2(`/api/conversations/${conversationId}`));
  assert.equal(initial.status, 200);
  assert.equal(initial.body.conversation.themeId, 'default');
  assert.deepEqual(initial.body.conversation.nicknames, {});

  // Update theme and nicknames as Alice
  const updated = await alice.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), {
    themeId: 'ocean',
    nicknames: { [bob.id]: 'Bobby', [alice.id]: 'Ali' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.conversation.themeId, 'ocean');
  assert.deepEqual(updated.body.conversation.nicknames, { [bob.id]: 'Bobby', [alice.id]: 'Ali' });
  // Canonical identities remain unchanged
  assert.equal(updated.body.conversation.participants.find((p: { id: string }) => p.id === bob.id).username, bob.username);

  // Multi-account synchronization: Bob sees the updated theme & nicknames on detail & list
  const bobDetail = await bob.browser.request(conversationV2(`/api/conversations/${conversationId}`));
  assert.equal(bobDetail.status, 200);
  assert.equal(bobDetail.body.conversation.themeId, 'ocean');
  assert.deepEqual(bobDetail.body.conversation.nicknames, { [bob.id]: 'Bobby', [alice.id]: 'Ali' });

  const bobList = await bob.browser.request('/api/conversations?contractVersion=2');
  assert.equal(bobList.body.items[0].themeId, 'ocean');
  assert.deepEqual(bobList.body.items[0].nicknames, { [bob.id]: 'Bobby', [alice.id]: 'Ali' });

  // Validation: rejects invalid themeId and non-participant targetId
  assert.equal((await alice.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), { themeId: 'neon' })).status, 400);
  assert.equal((await alice.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), { nicknames: { [outsider.id]: 'Intruder' } })).status, 400);

  // Outsider is denied
  assert.equal((await outsider.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), { themeId: 'sunset' })).status, 404);

  // Block & unblock: read-only conversation preserves preferences for viewing, but denies modifications until friendship is restored
  assert.equal((await alice.browser.mutate('POST', '/api/blocks', { userId: bob.id })).status, 204);
  assert.equal((await bob.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), { themeId: 'sunset' })).status, 404);
  assert.equal((await alice.browser.mutate('DELETE', `/api/blocks/${bob.id}`)).status, 204);
  const readOnly = await bob.browser.request(conversationV2(`/api/conversations/${conversationId}`));
  assert.equal(readOnly.body.conversation.interactionAllowed, false);
  assert.equal(readOnly.body.conversation.themeId, 'ocean');
  assert.equal((await bob.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), { themeId: 'sunset' })).status, 403);

  // Restore friendship -> can clear nickname and restore default theme
  await stack.befriend(alice, bob);
  const restored = await bob.browser.mutate('PATCH', conversationV2(`/api/conversations/${conversationId}/preferences`), {
    themeId: 'default',
    nicknames: { [bob.id]: null },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.conversation.themeId, 'default');
  assert.deepEqual(restored.body.conversation.nicknames, { [alice.id]: 'Ali' });
});
