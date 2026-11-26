'use strict';
// Real default-Docker acceptance. Only synthetic accounts and their own browser profiles are used.
const { chromium, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const origin = 'http://localhost:3001', cache = path.resolve(__dirname, '../../.cache');
const reuse = process.argv.indexOf('--reuse');
const dir = reuse < 0 ? path.join(cache, 'phase13c-buzz-' + randomBytes(4).toString('hex')) : path.resolve(process.argv[reuse + 1]);
if (path.dirname(dir) !== cache || !path.basename(dir).startsWith('phase13c-buzz-')) throw Error('Use an owned, ignored Buzz evidence directory.');
fs.mkdirSync(dir, { recursive: true });
const credentials = path.join(dir, 'credentials.json');
const accounts = fs.existsSync(credentials) ? JSON.parse(fs.readFileSync(credentials, 'utf8')) : [0, 1].map(i => ({
  username: 'buzz13c-' + i + '-' + path.basename(dir).slice(-8), displayName: i ? 'Buzz Bob' : 'Buzz Alice', password: randomBytes(24).toString('base64url'), registered: false,
}));
if (accounts.length !== 2 || accounts.some(a => !/^buzz13c-[01]-[a-f0-9]{8}$/.test(a.username))) throw Error('Only owned synthetic accounts may be used.');
const evidence = { origin, checks: [], errors: 0, buzzPayloads: [], passed: false };
const check = (name, passed) => { evidence.checks.push({ name, passed: Boolean(passed) }); console.log((passed ? 'PASS ' : 'FAIL ') + name); if (!passed) throw Error(name); };
async function api(page, route, method = 'GET', body) {
  return page.evaluate(async ({ route, method, body }) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })).json(); headers['X-CSRF-Token'] = csrf.csrfToken; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(route, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { route, method, body });
}
async function select(page, name) {
  await page.getByRole('button', { name: 'Refresh conversations', exact: true }).click();
  await page.getByRole('navigation', { name: 'Direct conversations' }).getByRole('button', { name: new RegExp('^' + name + ',') }).click();
  await expect(page.getByRole('status', { name: 'Live connection' })).toContainText('Connected', { timeout: 60000 });
  await expect(page.getByRole('textbox', { name: /^Message to / })).toBeEnabled({ timeout: 45000 });
  await expect(page.getByRole('button', { name: 'Send BUZZ alert' })).toBeEnabled();
}
(async () => {
  const contexts = [], pages = [], users = [];
  try {
    for (let i = 0; i < 2; i++) {
      const context = await chromium.launchPersistentContext(path.join(dir, 'profile-' + i), {
        executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, viewport: { width: 1440, height: 1000 },
      }); contexts.push(context);
      const page = await context.newPage(); pages.push(page); page.on('pageerror', () => evidence.errors++);
      page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
        const value = String(payload); if (!/^42\d*\[/.test(value)) return;
        try { const data = JSON.parse(value.slice(value.indexOf('['))); if (data[0] === 'buzz:send') evidence.buzzPayloads.push(Object.keys(data[1]).sort()); } catch { /* No payloads or credentials logged. */ }
      }));
      await page.goto(origin + '/login'); const account = accounts[i];
      if (!account.registered) {
        const result = await api(page, '/api/auth/register', 'POST', { ...account, email: account.username + '@example.test', registered: undefined });
        check('synthetic account registration ' + i + ' (HTTP ' + result.status + ')', result.status === 201);
        account.registered = true; fs.writeFileSync(credentials, JSON.stringify(accounts));
      }
      await expect(page.getByLabel('Username or email').or(page.getByRole('heading', { name: 'Your conversations', exact: true }))).toBeVisible({ timeout: 60000 });
      if (await page.getByLabel('Username or email').isVisible()) {
        await page.getByLabel('Username or email').fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      }
      await expect(page.getByRole('heading', { name: 'Your conversations', exact: true })).toBeVisible({ timeout: 60000 });
      users.push((await api(page, '/api/auth/me')).body.user);
      const enroll = page.getByRole('button', { name: /^Enroll this browser/ });
      await expect.poll(async () => await enroll.isVisible() || await page.getByText('Secure device ready', { exact: true }).isVisible(), { timeout: 45000 }).toBe(true);
      if (await enroll.isVisible()) { page.once('dialog', d => d.accept()); await enroll.click(); }
      await expect(page.getByText(/Secure device ready|Secure message ready/, { exact: true }).first()).toBeVisible({ timeout: 45000 });
    }
    const [alice, bob] = pages;
    let conversations = (await api(alice, '/api/conversations?limit=50')).body.items;
    if (!conversations.length) {
      const friend = await api(alice, '/api/friends/requests', 'POST', { userId: users[1].id }); check('authenticated friendship request', friend.status === 201);
      check('authenticated friendship acceptance', (await api(bob, '/api/friends/requests/' + friend.body.request.id + '/accept', 'POST')).status === 200);
      check('authenticated direct conversation', [200, 201].includes((await api(alice, '/api/conversations/dm', 'POST', { recipientId: users[1].id })).status));
      conversations = (await api(alice, '/api/conversations?limit=50')).body.items;
    }
    const cid = conversations[0].id;
    await select(alice, accounts[1].displayName); await select(bob, accounts[0].displayName);
    const history = () => api(alice, '/api/conversations/' + cid + '/messages?limit=50');
    const before = JSON.stringify((await history()).body);
    await alice.getByRole('textbox', { name: /^Message to / }).fill('Unsent composer draft stays intact');
    for (const page of pages) await page.evaluate(() => {
      window.__buzzEffects = [];
      new MutationObserver(records => { for (const r of records) if (r.attributeName === 'data-buzz-active' && r.target.matches('.real-messenger') && r.target.dataset.buzzActive === 'true') window.__buzzEffects.push(getComputedStyle(r.target).animationName); })
        .observe(document.querySelector('.real-messenger'), { attributes: true });
    });
    await bob.emulateMedia({ reducedMotion: 'reduce' });
    await alice.getByRole('button', { name: 'Send BUZZ alert' }).click();
    await expect(alice.getByRole('status', { name: 'Buzz notification' })).toHaveText('BUZZ! sent.');
    await expect(bob.getByRole('status', { name: 'Buzz notification' })).toHaveText('Buzz Alice sent you a BUZZ!');
    check('authenticated Buzz reaches the other browser profile', true);
    check('sender uses the whole-window shake animation', await alice.evaluate(() => window.__buzzEffects.includes('messenger-buzz-shake')));
    check('recipient reduced motion suppresses animation but retains notice', await bob.evaluate(() => window.__buzzEffects.length > 0 && window.__buzzEffects.every(x => x === 'none')));
    await expect(alice.getByRole('button', { name: 'Send BUZZ alert' })).toBeDisabled(); check('cooldown disables repeated Buzz without disabling the composer', await alice.getByRole('textbox', { name: /^Message to / }).isEnabled());
    await expect(alice.getByRole('textbox', { name: /^Message to / })).toHaveValue('Unsent composer draft stays intact');
    await bob.getByRole('button', { name: 'Send BUZZ alert' }).click();
    await expect(alice.getByRole('status', { name: 'Buzz notification' })).toHaveText('Buzz Bob sent you a BUZZ!'); check('recipient can Buzz back with its independent cooldown', true);
    await expect(alice.getByRole('button', { name: 'Send BUZZ alert' })).toBeEnabled({ timeout: 15000 });
    await bob.setViewportSize({ width: 390, height: 844 });
    check('mobile conversation has no horizontal overflow', await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await alice.reload(); await select(alice, accounts[1].displayName);
    check('reload does not replay a cached Buzz', await alice.getByRole('status', { name: 'Buzz notification' }).count() === 0);
    await alice.getByRole('button', { name: 'Send BUZZ alert' }).focus(); await alice.keyboard.press('Enter');
    await expect(bob.getByRole('status', { name: 'Buzz notification' })).toHaveText('Buzz Alice sent you a BUZZ!');
    check('keyboard activation works after authenticated reconnect', true);
    check('Buzz never changes message history', JSON.stringify((await history()).body) === before);
    check('Buzz wire requests contain only the conversation ID', evidence.buzzPayloads.length === 3 && evidence.buzzPayloads.every(keys => JSON.stringify(keys) === '["conversationId"]'));
    check('no browser runtime exceptions', evidence.errors === 0); evidence.passed = true;
  } catch (error) { evidence.failure = String(error.message).split('\n').slice(0, 8).join('\n').slice(0, 1000); console.error(evidence.failure); process.exitCode = 1; }
  finally { for (const context of contexts) await context.close(); fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log('Evidence: ' + path.relative(process.cwd(), dir)); }
})();
