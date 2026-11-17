/**
 * The combined production entry point (`src/data/main.ts`, `npm run start:data`) run as a real child
 * process on an isolated temporary database: DATA is loaded through `createRequire`, the realtime
 * server is mounted on DATA's own HTTP server, and a real account connects and sends.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { io as connectClient } from 'socket.io-client';
import { Browser, DATA_ROOT, ORIGIN, PASSWORD } from '../e2ee/support/dataApp.ts';
import { TestDevice } from '../e2ee/support/deviceClient.ts';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
let child: ChildProcessByStdio<null, Readable, Readable>;
let directory: string;
let base = '';
const stdout: string[] = [];
const stderr: string[] = [];

function started(): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`entry point did not start: ${stderr.join('')}`)), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk.toString('utf8'));
      for (const line of stdout.join('').split('\n')) {
        if (!line.includes('realtime.data.listening')) continue;
        clearTimeout(timer);
        resolve((JSON.parse(line) as { port: number }).port);
        return;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    child.once('exit', (code) => reject(new Error(`entry point exited with ${code}: ${stderr.join('')}`)));
  });
}

describe('npm run start:data (combined process)', () => {
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'secubuzz-e2ee-process-'));
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/data/main.ts'], {
      cwd: serverRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATA_ROOT,
        DB_PATH: join(directory, 'data.sqlite'),
        HOST: '127.0.0.1',
        PORT: '0',
        AUTH_ALLOW_HTTP_LOCAL: 'true',
        AUTH_ALLOWED_ORIGINS: ORIGIN,
      },
    });
    base = `http://127.0.0.1:${await started()}`;
  });
  after(async () => {
    child?.kill();
    await new Promise((resolve) => child?.once('exit', resolve) ?? resolve(null)).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(directory, { recursive: true, force: true });
  });

  test('the one process serves DATA\'s API and authenticated realtime, and a real account sends and receives encrypted v2 text', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const register = async (username: string, displayName: string) => {
      const browser = new Browser(base);
      assert.equal((await browser.request('/api/auth/register', { method: 'POST', headers: { 'X-CSRF-Token': await browser.csrf() },
        body: { username, email: `${username}@example.test`, password: PASSWORD, displayName } })).status, 201);
      const login = await browser.request('/api/auth/login', { method: 'POST', headers: { 'X-CSRF-Token': await browser.csrf() }, body: { identifier: username, password: PASSWORD } });
      assert.equal(login.status, 200);
      await browser.csrf();
      return { browser, id: login.body.user.id as string, displayName, device: await TestDevice.create(login.body.user.id as string) };
    };
    const alice = await register('proc-alice', 'Alice');
    const bob = await register('proc-bob', 'Bob');
    const request = await alice.browser.mutate('POST', '/api/friends/requests', { userId: bob.id });
    await bob.browser.mutate('POST', `/api/friends/requests/${request.body.request.id}/accept`);
    const conversationId = (await alice.browser.mutate('POST', '/api/conversations/dm', { recipientId: bob.id })).body.conversation.id as string;
    for (const person of [alice, bob]) assert.equal((await person.browser.mutate('POST', '/api/keys/devices', await person.device.registration())).status, 201);
    const state = await alice.browser.request(`/api/conversations/${conversationId}/keys`);
    const created = await alice.device.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: state.body.devices });
    assert.equal((await alice.browser.mutate('POST', `/api/conversations/${conversationId}/keys/epochs`, created.body)).status, 201);

    const open = (person: { browser: Browser }) => new Promise<ReturnType<typeof connectClient>>((resolve, reject) => {
      const socket = connectClient(base, {
        transports: ['websocket'], forceNew: true, reconnection: false,
        extraHeaders: { origin: ORIGIN, cookie: `secubuzz_session=${person.browser.cookies.get('secubuzz_session')}` },
        auth: { csrfToken: person.browser.token },
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (error) => reject(error));
    });
    const aliceSocket = await open(alice);
    const bobSocket = await open(bob);
    try {
      const received = new Promise<Record<string, any>>((resolve) => bobSocket.once('message:new', (payload) => resolve(payload)));
      const envelope = await alice.device.encrypt(created.key, created.body.keyId, { conversationId, id: 'proc-1', senderName: 'Alice' }, 'from the combined process');
      const ack = await aliceSocket.timeout(5_000).emitWithAck('message:send', envelope);
      assert.equal(ack.status, 'sent');
      const delivered = await received;
      assert.equal(delivered.id, 'proc-1');
      const bobState = await bob.browser.request(`/api/conversations/${conversationId}/keys`);
      const epochRecord = (await bob.browser.request(`/api/conversations/${conversationId}/keys/epochs/${created.body.keyId}`)).body.epoch;
      assert.equal(await TestDevice.decrypt(await bob.device.openEpoch(epochRecord, bobState.body.devices), delivered as never), 'from the combined process');
    } finally {
      aliceSocket.close();
      bobSocket.close();
    }
    // An origin outside DATA's list is refused by the same process.
    const hostile = connectClient(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { origin: 'http://evil.example' } });
    await new Promise<void>((resolve, reject) => {
      hostile.once('connect', () => reject(new Error('connected from a foreign origin')));
      hostile.once('connect_error', () => resolve());
    });
    hostile.close();
    assert.doesNotMatch(stdout.join('') + stderr.join(''), /ciphertext|csrf|secubuzz_session|from the combined process/i);
  });
});
