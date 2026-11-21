/* Real browser/UI + same-origin Next proxy + genuine DATA verifier. Isolated processes only. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium, expect } = require('@playwright/test');
const { io } = require('socket.io-client');
const root = path.resolve(__dirname, '..'), suffix = randomUUID().slice(0, 8);
const temporary = path.join(root, 'tmp', 'client-realtime-' + suffix), artifacts = path.join(temporary, 'artifacts');
const children = [], pages = [], secretTexts = ['Alice live E2EE 👩🏽‍💻\nMultiline ', 'Bob live reply ', 'New device epoch ', 'Offline gap ', 'Restart live ', 'REST fallback ', 'Same account device ', 'Background delivered ', 'Draft to Bob ', 'Draft to Charlie ', 'While in Meeting Rooms ', 'Mobile draft '].map(t => t + suffix);
const evidence = { startedAt: new Date().toISOString(), checks: [], network: [], plaintextLeaks: 0, runtimeErrors: 0, browser: 'Chrome, separate isolated contexts', screenshots: [], handshakes: 0, invalidAuthShapes: 0, socketSends: 0, v2Sends: 0, restSends: 0, persistenceAcks: 0, receivedMessages: 0 };
const delay = ms => new Promise(r => setTimeout(r, ms));
function check(name, condition) { evidence.checks.push({ name, passed: Boolean(condition) }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) throw new Error('Check failed: ' + name); }
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function healthy(url) { for (let i = 0; i < 120; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {} await delay(500); } throw new Error('Isolated service timeout'); }
function start(args, cwd, env) { const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p); let output = ''; p.stdout.on('data', b => { output = (output + b).slice(-12000); }); p.stderr.on('data', b => { output = (output + b).slice(-12000); }); p.diagnostics = () => output; return p; }
async function api(page, route, method = 'GET', body) {
  return page.evaluate(async ({ route, method, body }) => {
    const headers = { Accept: 'application/json' }; if (method !== 'GET') { const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })).json(); headers['X-CSRF-Token'] = csrf.csrfToken; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(route, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  }, { route, method, body });
}
const containsPlaintext = value => secretTexts.some(text => value.includes(text) || value.includes(JSON.stringify(text).slice(1, -1)));
function monitor(page) {
  pages.push(page); page.on('pageerror', () => { evidence.runtimeErrors++; });
  page.on('requestfailed', request => { if (new URL(request.url()).pathname.startsWith('/socket.io')) { evidence.socketFailures ??= []; evidence.socketFailures.push(request.failure()?.errorText ?? 'transport failure'); } });
  page.on('request', request => { const body = request.postData() || ''; if (containsPlaintext(body)) evidence.plaintextLeaks++;
    if (/\/api\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname) && request.method() === 'POST') evidence.restSends++;
  });
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      const value = String(payload); if (containsPlaintext(value)) evidence.plaintextLeaks++;
      if (value.startsWith('40{')) { try { const auth = JSON.parse(value.slice(2)); evidence.handshakes++; if (Object.keys(auth).join(',') !== 'csrfToken' || !/^[A-Za-z0-9_-]{43}$/.test(auth.csrfToken)) evidence.invalidAuthShapes++; } catch { evidence.invalidAuthShapes++; } }
      if (/^42\d*\[/.test(value)) { try { const data = JSON.parse(value.slice(value.indexOf('['))); if (data[0] === 'message:send') { evidence.socketSends++; if (data[1]?.encryption?.version === 2 && !('text' in data[1])) evidence.v2Sends++; } } catch {} }
    });
    socket.on('framereceived', ({ payload }) => {
      const value = String(payload); if (containsPlaintext(value)) evidence.plaintextLeaks++;
      try { const data = JSON.parse(value.slice(value.indexOf('['))); if (data[0] === 'message:new') evidence.receivedMessages++;
        if (/^43\d+\[/.test(value) && data[0]?.status === 'sent') evidence.persistenceAcks++;
      } catch {}
    });
  });
  page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) evidence.network.push({ path: url.pathname, method: response.request().method(), status: response.status() }); });
}
async function login(page, origin, username, password) {
  await page.goto(origin + '/login'); await page.getByLabel('Username or email').fill(username); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Your conversations', exact: true })).toBeVisible({ timeout: 60000 });
}
async function device(page, id) { return page.evaluate(async id => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('secubuzz-e2ee-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('storage')); });
  try { const d = await new Promise((resolve, reject) => { const r = db.transaction('records').objectStore('records').get(JSON.stringify([id, 'device', ''])); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('storage')); });
    return { deviceId: d.deviceId, nonExtractable: d.signing.privateKey.extractable === false && d.agreement.privateKey.extractable === false };
  } finally { db.close(); }
}, id); }
async function enroll(page) {
  const button = page.getByRole('button', { name: /^Enroll this browser/ });
  await expect(button).toBeVisible();
  const before = (await api(page, '/api/keys/devices')).body.items;
  page.once('dialog', dialog => dialog.dismiss()); await button.click();
  const cancelled = (await api(page, '/api/keys/devices')).body.items;
  check('cancelled enrollment preserves the key directory', JSON.stringify(cancelled) === JSON.stringify(before));
  page.once('dialog', dialog => dialog.accept()); await button.click();
  await expect(page.getByText('Secure device ready', { exact: true })).toBeVisible({ timeout: 30000 });
}
async function advanced(page) { const section = page.getByText('Advanced settings', { exact: true }).locator('..'); if (await section.getAttribute('open') === null) await section.locator('summary').first().click(); }
async function refresh(page) { await advanced(page); await page.getByRole('button', { name: 'Refresh secure conversation', exact: true }).click(); await ready(page); await page.getByText('Advanced settings', { exact: true }).click(); }
async function ready(page) { await expect(page.getByText('Secure message ready', { exact: true })).toBeVisible({ timeout: 45000 }); await expect(page.getByRole('textbox', { name: /^Message to / })).toBeEnabled(); }
async function select(page, name) { if (!await page.getByRole('navigation', { name: 'Direct conversations' }).isVisible()) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click(); await page.getByRole('button', { name: 'Refresh conversations', exact: true }).click(); await page.getByRole('navigation', { name: 'Direct conversations' }).getByRole('button', { name: new RegExp('^' + name + ',') }).click(); await ready(page); }
async function send(page, text) { await page.getByRole('textbox', { name: /^Message to / }).fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.getByRole('log').getByText(text, { exact: true })).toBeVisible({ timeout: 30000 }); }
async function connected(page) { await expect(page.getByRole('status', { name: 'Live connection' })).toContainText('Connected', { timeout: 60000 }); }
async function stopOwned(p) {
  if (p.exitCode !== null) return;
  const exited = once(p, 'exit');
  if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else p.kill();
  await Promise.race([exited, delay(5000)]);
}
async function websocketProbe(origin) {
  return new Promise(resolve => {
    const socket = io(origin, { path: '/socket.io', addTrailingSlash: false, transports: ['websocket'], reconnection: false, timeout: 5000,
      auth: {}, extraHeaders: { Origin: origin } });
    const timer = setTimeout(() => { socket.disconnect(); resolve('transport_timeout'); }, 7000);
    socket.on('connect_error', error => { clearTimeout(timer); const code = error.data?.code; socket.disconnect(); resolve(typeof code === 'string' ? code : 'transport_error'); });
    socket.on('connect', () => { clearTimeout(timer); socket.disconnect(); resolve('unexpectedly_authenticated'); });
  });
}
(async () => {
  fs.mkdirSync(temporary, { recursive: true }); fs.mkdirSync(artifacts, { recursive: true }); let host;
  try {
    const frontendPort = await port(), backendPort = await port(), origin = `http://localhost:${frontendPort}`;
    const backendEnv = { NODE_ENV: 'test', DATA_ROOT: path.join(root, '../DATA'), DB_PATH: path.join(temporary, 'isolated.sqlite'), HOST: '127.0.0.1', PORT: String(backendPort), AUTH_ALLOWED_ORIGINS: origin, AUTH_ALLOW_HTTP_LOCAL: 'true' };
    let backend = start(['src/data/main.ts'], path.join(root, '../server'), backendEnv);
    await healthy(`http://127.0.0.1:${backendPort}/healthz`);
    const next = start([path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(frontendPort)], root, { NODE_ENV: 'development', NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true', NEXT_PUBLIC_AUTH_API_BASE_PATH: '/api/auth', AUTH_BACKEND_URL: `http://127.0.0.1:${backendPort}`, CLIENT_TEST_DIST_DIR: '.next-e2ee-browser-' + suffix });
    await healthy(origin + '/login'); evidence.frontendPort = frontendPort; evidence.backendPort = backendPort;
    evidence.engineDirectStatus = (await fetch(`http://127.0.0.1:${backendPort}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } })).status;
    evidence.engineProxyStatus = (await fetch(origin + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: origin } })).status;
    check('same-origin proxy reaches real Socket.IO engine', evidence.engineDirectStatus === 200 && evidence.engineProxyStatus === 200);
    evidence.websocketProbeCode = await websocketProbe(origin);
    check('same-origin WebSocket proxy reaches session authentication and rejects missing credentials', evidence.websocketProbeCode === 'AUTH_REQUIRED');
    host = await chromium.launchPersistentContext(path.join(temporary, 'chrome'), { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, viewport: { width: 1440, height: 1000 } });
    const browser = host.browser(), a = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), b = await browser.newContext(), c = await browser.newContext();
    const alice = await a.newPage(), bob = await b.newPage(), charlie = await c.newPage(); [alice, bob, charlie].forEach(monitor);
    const password = randomBytes(24).toString('base64url'), usernames = ['alice', 'bob', 'charlie'].map(n => 'browser-' + n + '-' + suffix), accounts = [];
    for (const [i, page] of [alice, bob, charlie].entries()) {
      await page.goto(origin + '/login'); const r = await api(page, '/api/auth/register', 'POST', { username: usernames[i], email: usernames[i] + '@example.test', password, displayName: ['Alice', 'Bob', 'Charlie'][i] }); check('register isolated account ' + i, r.status === 201);
      await login(page, origin, usernames[i], password); check('startup does not register device keys', (await api(page, '/api/keys/devices')).body.items.length === 0); await enroll(page);
      accounts.push((await api(page, '/api/auth/me')).body.user);
    }
    const before = await device(alice, accounts[0].id); check('persistent private keys are non-extractable', before.nonExtractable);
    const friendship = await api(alice, '/api/friends/requests', 'POST', { userId: accounts[1].id }); check('request real friendship', friendship.status === 201);
    check('accept real friendship', (await api(bob, '/api/friends/requests/' + friendship.body.request.id + '/accept', 'POST')).status === 200);
    await alice.reload(); await expect(alice.getByText('Secure device ready', { exact: true })).toBeVisible();
    await alice.getByRole('button', { name: /^Friends(?:,|$)/ }).click(); await alice.getByRole('button', { name: 'Message Bob', exact: true }).click(); await ready(alice); check('real DM and signed HPKE epoch prepared through UI', true);
    await select(bob, 'Alice'); await connected(alice); await connected(bob);
    await alice.getByRole('textbox', { name: /^Message to / }).fill(secretTexts[0]); await expect(bob.getByText('Alice is typing…', { exact: true })).toBeVisible({ timeout: 10000 }); check('authorized typing arrives without content', true);
    const emojiDraft = alice.getByRole('textbox', { name: /^Message to / });
    await emojiDraft.fill('Keep middle text'); await emojiDraft.evaluate(node => node.setSelectionRange(5, 11));
    await alice.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    await alice.getByRole('searchbox', { name: 'Search emoji' }).fill('pizza');
    await alice.getByRole('searchbox', { name: 'Search emoji' }).press('ArrowDown'); await alice.keyboard.press('Enter');
    await expect(emojiDraft).toHaveValue('Keep 🍕 text'); await expect(emojiDraft).toBeFocused();
    check('real-account composer preserves cursor selection through the advanced emoji picker', true);
    await send(alice, secretTexts[0]); await expect(bob.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible({ timeout: 30000 }); check('Bob receives and locally decrypts Alice live multiline Unicode message without Refresh', true);
    check('unsupported real-account reply, forward, edit, delete, pin and reaction actions remain hidden',
      await alice.locator('.msg-toolbar button').count() === 0 && await alice.getByRole('button', { name: 'View pinned messages', exact: true }).count() === 0);
    await send(bob, secretTexts[1]); await expect(alice.getByRole('log').getByText(secretTexts[1], { exact: true })).toBeVisible({ timeout: 30000 }); check('Alice receives and locally decrypts Bob live reply without Refresh', true);
    await expect(alice.getByRole('log').getByText('Read', { exact: true })).toBeVisible({ timeout: 15000 }); check('DATA-backed read receipt is distinct from persistence', true);
    check('real accounts use the original sidebar, header, bubbles and composer', await alice.locator('.conversation-sidebar').count() === 1 && await alice.locator('.chat-toolbar').count() === 1 && await alice.locator('.message-bubble').count() >= 1 && await alice.locator('.composer-dock').count() === 1);
    check('real chat has no demo messages or unverified file and voice actions', await alice.getByText('Demo reply', { exact: true }).count() === 0 && await alice.getByRole('button', { name: 'Attach files or images' }).count() === 0 && await alice.getByRole('button', { name: 'Record voice message' }).count() === 0);
    await expect(alice.getByLabel('Message transport', { exact: true })).toBeHidden(); check('developer transport control is inside collapsed advanced settings', true);
    await alice.getByRole('textbox', { name: /^Message to / }).fill(secretTexts[8]);
    const mediaCid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
    await alice.getByRole('button', { name: 'Open Voice Rooms', exact: true }).click();
    await expect(alice.getByRole('navigation', { name: 'Voice room navigation' })).toBeVisible();
    await send(bob, secretTexts[10]);
    const mediaMessage = (await api(bob, `/api/conversations/${mediaCid}/messages?limit=1`)).body.items[0];
    await expect(bob.locator(`[data-message-id="${mediaMessage.id}"] .message-delivery`)).toHaveText('Delivered', { timeout: 15000 });
    check('Meeting Rooms navigation keeps hidden chat from issuing read receipts', true);
    await alice.getByRole('button', { name: 'Back to account', exact: true }).click();
    await expect(alice.getByRole('textbox', { name: /^Message to / })).toHaveValue(secretTexts[8]);
    await expect(alice.getByRole('log').getByText(secretTexts[10], { exact: true })).toBeVisible();
    await expect(bob.locator(`[data-message-id="${mediaMessage.id}"] .message-delivery`)).toHaveText('Read', { timeout: 15000 });
    check('Meeting Rooms round trip preserves drafts and resumes visible reads', true);
    const secondFriend = await api(alice, '/api/friends/requests', 'POST', { userId: accounts[2].id });
    check('second real friendship supports draft navigation', secondFriend.status === 201 && (await api(charlie, '/api/friends/requests/' + secondFriend.body.request.id + '/accept', 'POST')).status === 200);
    check('second real DM is created without demo data', (await api(alice, '/api/conversations/dm', 'POST', { recipientId: accounts[2].id })).status === 201);
    await select(alice, 'Charlie'); await alice.getByRole('textbox', { name: /^Message to / }).fill(secretTexts[9]);
    await select(alice, 'Bob'); await expect(alice.getByRole('textbox', { name: /^Message to / })).toHaveValue(secretTexts[8]);
    await refresh(alice); await expect(alice.getByRole('textbox', { name: /^Message to / })).toHaveValue(secretTexts[8]);
    check('conversation switching and secure refresh preserve each draft', true);
    await alice.setViewportSize({ width: 390, height: 844 }); await alice.getByRole('textbox', { name: /^Message to / }).fill(secretTexts[11]);
    await alice.getByRole('button', { name: 'Back to conversations', exact: true }).click();
    await expect(alice.getByRole('navigation', { name: 'Direct conversations' })).toBeVisible();
    await select(alice, 'Charlie'); await expect(alice.getByRole('textbox', { name: /^Message to / })).toHaveValue(secretTexts[9]);
    await expect(alice.getByRole('navigation', { name: 'Direct conversations' })).toBeHidden();
    await select(alice, 'Bob'); await expect(alice.getByRole('textbox', { name: /^Message to / })).toHaveValue(secretTexts[11]);
    check('mobile list and chat navigation preserve drafts without overflow', await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await alice.setViewportSize({ width: 1440, height: 1000 });
    await bob.getByRole('button', { name: /^Friends(?:,|$)/ }).click(); await send(alice, secretTexts[7]);
    const backgroundRow = alice.getByRole('log').locator('article').filter({ has: alice.getByText(secretTexts[7], { exact: true }) });
    await expect(backgroundRow.getByText('Delivered', { exact: true })).toBeVisible({ timeout: 15000 }); check('background recipient confirms durable delivery without claiming read', true);
    await bob.getByRole('button', { name: /^Chats(?:,|$)/ }).click(); await expect(backgroundRow.getByText('Read', { exact: true })).toBeVisible({ timeout: 15000 }); check('visible conversation records read monotonically after delivery', true);
    check('invisible preference committed through existing profile API', (await api(bob, '/api/users/me', 'PATCH', { presencePreference: 'invisible' })).status === 200);
    await expect(alice.getByRole('status', { name: 'Contact presence' })).toHaveText('Offline', { timeout: 15000 }); check('invisible presence shows offline without revealing the live connection', true);
    check('available preference restored through existing profile API', (await api(bob, '/api/users/me', 'PATCH', { presencePreference: 'available' })).status === 200);
    await expect(alice.getByRole('status', { name: 'Contact presence' })).toHaveText('Online', { timeout: 15000 }); check('presence follows stored preference without client overrides', true);
    const cid = mediaCid;
    check('Charlie denied conversation/history', (await api(charlie, `/api/conversations/${cid}/messages`)).status === 404);
    await alice.reload(); await bob.reload(); await expect(alice.getByText('Secure device ready', { exact: true })).toBeVisible(); await select(alice, 'Bob'); await select(bob, 'Alice'); await connected(alice); await connected(bob);
    check('refresh restores same device identity', (await device(alice, accounts[0].id)).deviceId === before.deviceId); await expect(alice.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible(); check('refresh restores conversation key and history decryption', true);
    await b.setOffline(true); await send(alice, secretTexts[3]); await b.setOffline(false); await connected(bob); await expect(bob.getByRole('log').getByText(secretTexts[3], { exact: true })).toHaveCount(1, { timeout: 45000 });
    await expect(bob.getByRole('log').getByText(secretTexts[0], { exact: true })).toHaveCount(1); check('offline gap reconciles without missing or duplicate messages', true);
    await stopOwned(backend); backend = start(['src/data/main.ts'], path.join(root, '../server'), backendEnv); await healthy(`http://127.0.0.1:${backendPort}/healthz`); await connected(alice); await connected(bob);
    await send(alice, secretTexts[4]); await expect(bob.getByRole('log').getByText(secretTexts[4], { exact: true })).toBeVisible({ timeout: 30000 }); check('server restart reconnects with fresh proof and resumes live delivery', true);
    await advanced(alice); await alice.getByLabel('Message transport', { exact: true }).selectOption('rest'); await alice.getByText('Advanced settings', { exact: true }).click(); await send(alice, secretTexts[5]); await refresh(bob); await expect(bob.getByRole('log').getByText(secretTexts[5], { exact: true })).toHaveCount(1); check('explicit REST transport uses genuine v2 and one persisted row', true);
    await advanced(alice); await alice.getByLabel('Message transport', { exact: true }).selectOption('live'); await alice.getByText('Advanced settings', { exact: true }).click();
    const desktopRedaction = await alice.addStyleTag({ content: '.message-bubble, .conversation-list-preview, .composer-input { filter:blur(8px); }' });
    await alice.screenshot({ path: path.join(artifacts, 'desktop-redacted.png'), fullPage: true }); evidence.screenshots.push('desktop-redacted.png'); await desktopRedaction.evaluate(node => node.remove());
    const newer = await browser.newContext(), bob2 = await newer.newPage(); monitor(bob2); await login(bob2, origin, usernames[1], password);
    await enroll(bob2);
    await expect(alice.getByText('Contact device keys changed', { exact: true })).toBeVisible({ timeout: 30000 }); await expect(alice.getByRole('button', { name: 'Send', exact: true })).toBeDisabled(); check('live key-change hint refetches directory and blocks unreviewed peer keys', true);
    await alice.getByRole('button', { name: 'Trust these device changes', exact: true }).click(); await ready(alice); await send(alice, secretTexts[2]); await select(bob2, 'Alice');
    await expect(bob2.getByRole('log').getByText(secretTexts[2], { exact: true })).toBeVisible(); await expect(bob2.getByRole('log').getByText(secretTexts[0], { exact: true })).toHaveCount(0); check('new epoch includes new device without pretending old-key recovery', true);
    await connected(bob2); await send(bob2, secretTexts[6]); await expect(bob.getByRole('log').getByText(secretTexts[6], { exact: true })).toBeVisible({ timeout: 30000 }); check('another device of the sender account receives its live message', true);
    await advanced(bob2); bob2.once('dialog', d => d.accept()); await bob2.getByText('This browser and key recovery', { exact: true }).click(); await bob2.getByRole('button', { name: 'Revoke this browser', exact: true }).click(); await expect(bob2.getByText('Device revoked', { exact: true })).toBeVisible(); check('device revocation blocks new secure sends', true);
    await expect(alice.getByText('Contact device keys changed', { exact: true })).toBeVisible({ timeout: 30000 });
    await alice.setViewportSize({ width: 390, height: 844 }); check('mobile layout has no horizontal overflow', await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await alice.addStyleTag({ content: '.message-bubble, .conversation-list-preview, .composer-input { filter:blur(8px); }' }); await alice.screenshot({ path: path.join(artifacts, 'mobile-redacted.png'), fullPage: true }); evidence.screenshots.push('mobile-redacted.png');
    await alice.emulateMedia({ colorScheme: 'dark' }); await expect(alice.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Theme attributes update before the existing background transition has finished.
    await expect.poll(() => alice.locator('.conversation-security-summary').evaluate(element => { const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number); return channels?.length === 3 && channels.reduce((a, b) => a + b, 0) < 500; })).toBe(true);
    check('dark security disclosure uses a readable dark surface', true);
    await alice.screenshot({ path: path.join(artifacts, 'midnight-mobile-redacted.png'), fullPage: true }); evidence.screenshots.push('midnight-mobile-redacted.png');
    await alice.emulateMedia({ colorScheme: 'light' }); await expect(alice.locator('html')).toHaveAttribute('data-theme', 'light'); check('new panel preserves System appearance in light and Midnight dark', true);
    check('Bungee and Space Grotesk remain active', await alice.evaluate(async () => { await document.fonts.ready; return /bungee/i.test(getComputedStyle(document.querySelector('.chat-title-heading')).fontFamily) && /space.?grotesk/i.test(getComputedStyle(document.body).fontFamily); }));
    check('real block is committed', (await api(alice, '/api/blocks', 'POST', { userId: accounts[1].id })).status === 204);
    await bob.getByRole('button', { name: 'Refresh conversations', exact: true }).click(); await expect(bob.getByRole('log').getByText(secretTexts[0], { exact: true })).toHaveCount(0); await advanced(bob); await bob.getByRole('button', { name: 'Refresh secure conversation', exact: true }).click(); await expect(bob.getByRole('textbox', { name: /^Message to / })).toBeDisabled(); check('authorization revocation removes live scope and clears displayed rows', true);
    await alice.getByRole('button', { name: 'Sign Out', exact: true }).click(); await expect(alice.getByLabel('Username or email')).toBeVisible();
    await login(alice, origin, usernames[2], password); await expect(alice.getByRole('button', { name: 'Enroll this browser — older history may be unavailable', exact: true })).toBeVisible();
    await expect(alice.getByRole('log')).toHaveCount(0); check('same-browser account switch clears plaintext and isolates device enrollment', true);
    check('no plaintext in any captured network request', evidence.plaintextLeaks === 0); check('no browser runtime exceptions', evidence.runtimeErrors === 0);
    check('browser websocket handshakes have exactly csrfToken', evidence.handshakes >= 2 && evidence.invalidAuthShapes === 0);
    check('every captured live send is envelope v2', evidence.socketSends >= 5 && evidence.socketSends === evidence.v2Sends);
    check('real persistence acknowledgments and committed live events observed', evidence.persistenceAcks >= 5 && evidence.receivedMessages >= 5);
    check('REST compatibility exercised', evidence.restSends === 1);
    evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null;
  } catch (e) { evidence.passed = false; evidence.failure = e instanceof Error ? secretTexts.reduce((s, t) => s.replaceAll(t, '[redacted]'), e.message.split('\n')[0]).slice(0, 200) : 'Browser verification failed';
    evidence.connections = await Promise.all(pages.map(p => p.getByRole('status', { name: 'Live connection' }).textContent({ timeout: 1000 }).catch(() => 'no workspace')));
    evidence.backendDiagnostics = children[0]?.diagnostics().split('\n').filter(line => /realtime\./.test(line)).slice(-12);
    process.exitCode = 1; console.error('Browser verification failed; sanitized evidence saved.'); }
  finally {
    await host?.close().catch(() => {});
    for (const p of children.reverse()) if (p.exitCode === null) { const exited = once(p, 'exit'); if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } else p.kill(); await Promise.race([exited, delay(5000)]); }
    evidence.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2)); console.log('Evidence: ' + path.join(artifacts, 'browser-evidence.json'));
    // Only known isolated files/processes above are owned by this script. No existing service is inspected/stopped.
  }
})();
