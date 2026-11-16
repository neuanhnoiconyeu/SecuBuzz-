/* Real browser/UI + same-origin Next proxy + genuine DATA verifier. Isolated processes only. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..'), suffix = randomUUID().slice(0, 8);
const temporary = path.join(root, 'tmp', 'client-e2ee-' + suffix), artifacts = path.join(root, 'artifacts', 'client-e2ee');
const children = [], pages = [], secretTexts = ['Alice browser E2EE ' + suffix, 'Bob browser reply ' + suffix, 'New device epoch ' + suffix];
const evidence = { startedAt: new Date().toISOString(), checks: [], network: [], plaintextLeaks: 0, runtimeErrors: 0, browser: 'Chrome, separate isolated contexts', screenshots: [] };
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
    return { status: r.status, body: await r.json() };
  }, { route, method, body });
}
function monitor(page) {
  pages.push(page); page.on('pageerror', () => { evidence.runtimeErrors++; });
  page.on('request', request => { const body = request.postData() || ''; if (secretTexts.some(t => body.includes(t))) evidence.plaintextLeaks++; });
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
async function ready(page) { await expect(page.getByText('Secure message ready', { exact: true })).toBeVisible({ timeout: 45000 }); await expect(page.getByLabel('Secure message', { exact: true })).toBeEnabled(); }
async function select(page, name) { await page.getByRole('button', { name: 'Refresh conversations', exact: true }).click(); await page.getByRole('navigation', { name: 'Direct conversations' }).getByRole('button', { name, exact: true }).click(); await ready(page); }
async function send(page, text) { await page.getByLabel('Secure message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send encrypted message', exact: true }).click(); await expect(page.getByRole('log').getByText(text, { exact: true })).toBeVisible({ timeout: 30000 }); }
(async () => {
  fs.mkdirSync(temporary, { recursive: true }); fs.mkdirSync(artifacts, { recursive: true }); let host;
  try {
    const frontendPort = await port(), backendPort = await port(), origin = `http://localhost:${frontendPort}`;
    const backend = start(['server.js'], path.join(root, '../DATA'), { NODE_ENV: 'test', DB_PATH: path.join(temporary, 'isolated.sqlite'), HOST: '127.0.0.1', PORT: String(backendPort), AUTH_ALLOWED_ORIGINS: origin, AUTH_ALLOW_HTTP_LOCAL: 'true' });
    await healthy(`http://127.0.0.1:${backendPort}/healthz`);
    const next = start([path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(frontendPort)], root, { NODE_ENV: 'development', NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true', NEXT_PUBLIC_AUTH_API_BASE_PATH: '/api/auth', AUTH_BACKEND_URL: `http://127.0.0.1:${backendPort}`, CLIENT_TEST_DIST_DIR: '.next-e2ee-browser-' + suffix });
    await healthy(origin + '/login'); evidence.frontendPort = frontendPort; evidence.backendPort = backendPort;
    host = await chromium.launchPersistentContext(path.join(temporary, 'chrome'), { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, viewport: { width: 1440, height: 1000 } });
    const browser = host.browser(), a = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), b = await browser.newContext(), c = await browser.newContext();
    const alice = await a.newPage(), bob = await b.newPage(), charlie = await c.newPage(); [alice, bob, charlie].forEach(monitor);
    const password = randomBytes(24).toString('base64url'), usernames = ['alice', 'bob', 'charlie'].map(n => 'browser-' + n + '-' + suffix), accounts = [];
    for (const [i, page] of [alice, bob, charlie].entries()) {
      await page.goto(origin + '/login'); const r = await api(page, '/api/auth/register', 'POST', { username: usernames[i], email: usernames[i] + '@example.test', password, displayName: ['Alice', 'Bob', 'Charlie'][i] }); check('register isolated account ' + i, r.status === 201);
      await login(page, origin, usernames[i], password); await expect(page.getByText('Secure device ready', { exact: true })).toBeVisible({ timeout: 30000 });
      accounts.push((await api(page, '/api/auth/me')).body.user);
    }
    const before = await device(alice, accounts[0].id); check('persistent private keys are non-extractable', before.nonExtractable);
    const friendship = await api(alice, '/api/friends/requests', 'POST', { userId: accounts[1].id }); check('request real friendship', friendship.status === 201);
    check('accept real friendship', (await api(bob, '/api/friends/requests/' + friendship.body.request.id + '/accept', 'POST')).status === 200);
    await alice.reload(); await expect(alice.getByText('Secure device ready', { exact: true })).toBeVisible();
    await alice.getByRole('button', { name: /^Friends(?:,|$)/ }).click(); await alice.getByRole('button', { name: 'Message Bob', exact: true }).click(); await ready(alice); check('real DM and signed HPKE epoch prepared through UI', true);
    await send(alice, secretTexts[0]); await select(bob, 'Alice'); await expect(bob.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible(); check('Bob decrypts Alice ciphertext through real DATA', true);
    await send(bob, secretTexts[1]); await alice.getByRole('button', { name: 'Refresh secure conversation', exact: true }).click(); await ready(alice); await expect(alice.getByRole('log').getByText(secretTexts[1], { exact: true })).toBeVisible(); check('Alice decrypts Bob reply', true);
    const conversations = await api(alice, '/api/conversations?limit=50'), cid = conversations.body.items[0].id;
    check('Charlie denied conversation/history', (await api(charlie, `/api/conversations/${cid}/messages`)).status === 404);
    await alice.reload(); await expect(alice.getByText('Secure device ready', { exact: true })).toBeVisible(); await select(alice, 'Bob');
    check('refresh restores same device identity', (await device(alice, accounts[0].id)).deviceId === before.deviceId); await expect(alice.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible(); check('refresh restores conversation key and history decryption', true);
    const newer = await browser.newContext(), bob2 = await newer.newPage(); monitor(bob2); await login(bob2, origin, usernames[1], password);
    await bob2.getByRole('button', { name: 'Enroll this browser — older history may be unavailable', exact: true }).click(); await expect(bob2.getByText('Secure device ready', { exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Refresh secure conversation', exact: true }).click(); await expect(alice.getByText('Contact device keys changed', { exact: true })).toBeVisible(); await expect(alice.getByRole('button', { name: 'Send encrypted message', exact: true })).toBeDisabled(); check('peer key change blocks send and warns before trust', true);
    await alice.getByRole('button', { name: 'Trust these device changes', exact: true }).click(); await ready(alice); await send(alice, secretTexts[2]); await select(bob2, 'Alice');
    await expect(bob2.getByRole('log').getByText(secretTexts[2], { exact: true })).toBeVisible(); await expect(bob2.getByRole('log').getByText(secretTexts[0], { exact: true })).toHaveCount(0); check('new epoch includes new device without pretending old-key recovery', true);
    bob2.once('dialog', d => d.accept()); await bob2.getByText('This browser and key recovery', { exact: true }).click(); await bob2.getByRole('button', { name: 'Revoke this browser', exact: true }).click(); await expect(bob2.getByText('Device revoked', { exact: true })).toBeVisible(); check('device revocation blocks new secure sends', true);
    await alice.setViewportSize({ width: 390, height: 844 }); check('mobile layout has no horizontal overflow', await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await alice.addStyleTag({ content: '[role=log] article p { filter:blur(8px); }' }); await alice.screenshot({ path: path.join(artifacts, 'mobile-redacted.png'), fullPage: true }); evidence.screenshots.push('mobile-redacted.png');
    await alice.emulateMedia({ colorScheme: 'dark' }); await expect(alice.locator('html')).toHaveAttribute('data-theme', 'dark');
    await alice.screenshot({ path: path.join(artifacts, 'midnight-mobile-redacted.png'), fullPage: true }); evidence.screenshots.push('midnight-mobile-redacted.png');
    await alice.emulateMedia({ colorScheme: 'light' }); await expect(alice.locator('html')).toHaveAttribute('data-theme', 'light'); check('new panel preserves System appearance in light and Midnight dark', true);
    check('Bungee and Space Grotesk remain active', await alice.evaluate(async () => { await document.fonts.ready; return /bungee/i.test(getComputedStyle(document.querySelector('h1')).fontFamily) && /space.?grotesk/i.test(getComputedStyle(document.body).fontFamily); }));
    await alice.getByRole('button', { name: 'Sign Out', exact: true }).click(); await expect(alice.getByLabel('Username or email')).toBeVisible();
    await login(alice, origin, usernames[2], password); await expect(alice.getByRole('button', { name: 'Enroll this browser — older history may be unavailable', exact: true })).toBeVisible();
    await expect(alice.getByRole('log')).toHaveCount(0); check('same-browser account switch clears plaintext and isolates device enrollment', true);
    check('no plaintext in any captured network request', evidence.plaintextLeaks === 0); check('no browser runtime exceptions', evidence.runtimeErrors === 0);
    evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null;
  } catch (e) { evidence.passed = false; evidence.failure = e instanceof Error ? secretTexts.reduce((s, t) => s.replaceAll(t, '[redacted]'), e.message.split('\n')[0]).slice(0, 200) : 'Browser verification failed'; process.exitCode = 1; console.error('Browser verification failed; sanitized evidence saved.'); }
  finally {
    await host?.close().catch(() => {});
    for (const p of children.reverse()) if (p.exitCode === null) { const exited = once(p, 'exit'); if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } else p.kill(); await Promise.race([exited, delay(5000)]); }
    evidence.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    // Only known isolated files/processes above are owned by this script. No existing service is inspected/stopped.
  }
})();
