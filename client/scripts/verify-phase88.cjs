/* Real Chrome + unmodified DATA integration. Creates only isolated test accounts and DB. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { startServer } = require('../../DATA/server/start');
const client = path.resolve(__dirname, '..');
const artifacts = path.join(client, 'artifacts/phase8-8');
const temporary = path.join(client, 'tmp/phase88-' + crypto.randomUUID());
const evidence = { startedAt: new Date().toISOString(), checks: [], screenshots: [], network: [], runtimeErrors: 0 };
const children = []; const sockets = []; const descriptors = [];
let application, browser, alice, bob, nextProcess, origin, backendEnv;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, passed, details) {
  evidence.checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
  if (!passed) throw new Error(name);
}
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function http(url, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return response; } catch {}
    await pause(200);
  }
  throw new Error('Server did not become ready');
}
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.pending = new Map(); this.id = 0;
    sockets.push(this.ws);
    this.ready = new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve); this.ws.addEventListener('error', reject); });
    this.ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.id) {
        const pending = this.pending.get(packet.id); if (!pending) return;
        this.pending.delete(packet.id); clearTimeout(pending.timer);
        packet.error ? pending.reject(new Error(packet.error.message)) : pending.resolve(packet.result ?? {});
      } else if (packet.method === 'Runtime.exceptionThrown') evidence.runtimeErrors += 1;
      else if (packet.method === 'Network.responseReceived') {
        const response = packet.params.response; const url = new URL(response.url);
        if (url.pathname.startsWith('/api/')) evidence.network.push({ path: url.pathname, status: response.status });
      }
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 25000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Browser evaluation failed');
    return result.result?.value;
  }
}
async function wait(cdp, expression, label, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await cdp.eval(`Boolean(${expression})`)) return; } catch {}
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
async function click(cdp, selector) {
  const expression = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getBoundingClientRect().width && !e.disabled)`;
  await wait(cdp, expression, 'control ' + selector);
  await cdp.eval(`(${expression}).click()`); await pause(80);
}
async function textClick(cdp, text, root = 'body') {
  const expression = `[...document.querySelectorAll(${JSON.stringify(root + ' button')})].find(e => e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width && !e.disabled)`;
  await wait(cdp, expression, 'button ' + text); await cdp.eval(`(${expression}).click()`); await pause(100);
}
async function input(cdp, selector, value) {
  await wait(cdp, `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, 'input ' + selector);
  await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await pause(80);
}
async function navigate(cdp, route) {
  await cdp.send('Page.navigate', { url: origin + route });
  await wait(cdp, `location.pathname === ${JSON.stringify(route.split('#')[0])} && document.readyState === 'complete'`, 'navigation ' + route);
}
async function screenshot(cdp, name) {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifacts, name), Buffer.from(image.data, 'base64')); evidence.screenshots.push(name);
}
async function isolatedPage() {
  const context = await browser.send('Target.createBrowserContext');
  const target = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId });
  const pages = await (await fetch(evidence.debugOrigin + '/json/list')).json();
  const cdp = new CDP(pages.find(page => page.id === target.targetId).webSocketDebuggerUrl);
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await cdp.send(method);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  return cdp;
}
const password = 'Phase 8.8 real browser password';
async function signup(cdp, username) {
  await navigate(cdp, '/signup'); await input(cdp, '#auth-username', username); await input(cdp, '#auth-email', `${username}@example.test`);
  await input(cdp, '#auth-password', password); await input(cdp, '#auth-confirm-password', password); await textClick(cdp, 'Create Account');
  await wait(cdp, `location.pathname === '/login'`, 'signup requires login');
  check(username + ' registration requires explicit login', await cdp.eval(`!document.querySelector('.messenger-navigation')`));
}
async function login(cdp, username) {
  await navigate(cdp, '/login'); await input(cdp, '#auth-identifier', username); await input(cdp, '#auth-password', password); await textClick(cdp, 'Sign In');
  await wait(cdp, `document.querySelector('.real-messenger') && document.querySelector('.navigation-profile-name')?.textContent !== 'Profile'`, 'real workspace');
  check(username + ' real Messenger shell and empty conversations', await cdp.eval(`document.querySelector('#real-chats-title')?.textContent === 'No conversations yet' && !document.querySelector('[role="log"]') && !document.querySelector('#message-input')`));
}
async function friends(cdp, tab = 'All Friends') {
  await click(cdp, '.messenger-navigation-tabs button:nth-child(2)');
  const selector = `[...document.querySelectorAll('[role="tab"]')].find(e => e.textContent.startsWith(${JSON.stringify(tab)}))`;
  await wait(cdp, selector, tab); await cdp.eval(`(${selector}).click()`); await pause(100);
  await wait(cdp, `!document.querySelector('.friends-page [role="tabpanel"]:not([hidden])')?.getAttribute('aria-busy') || document.querySelector('.friends-page [role="tabpanel"]:not([hidden])')?.getAttribute('aria-busy') === 'false'`, 'friends settled');
}
async function refresh(cdp) {
  await textClick(cdp, 'Refresh Friends'); await pause(200);
  await wait(cdp, `!document.querySelector('button[aria-label^="Add "]')?.disabled && ![...document.querySelectorAll('[role="status"]')].some(e => e.getBoundingClientRect().width && e.textContent === 'Loading friends…')`, 'refresh');
}
async function search(cdp, query) {
  await friends(cdp, 'Find Friends'); await input(cdp, '#friends-discovery', query);
  await wait(cdp, `!document.querySelector('.friends-page')?.textContent.includes('Searching usernames…')`, 'search settled'); await pause(500);
}
async function notice(cdp, text) { await wait(cdp, `document.querySelector('.friends-page')?.textContent.includes(${JSON.stringify(text)})`, text); }
async function send() { await search(alice, 'bob'); await click(alice, 'button[aria-label="Add bob as a friend"]'); await notice(alice, 'Friend request sent.'); }
async function receive(action) { await friends(bob, 'Pending Requests'); await refresh(bob); await click(bob, `button[aria-label="${action} request from Alice Persisted"]`); await notice(bob, action === 'Accept' ? 'Friend request accepted.' : 'Friend request declined.'); }
async function confirmAction(cdp, menu, action) {
  await textClick(cdp, `More actions for ${menu}`); await textClick(cdp, action);
  await textClick(cdp, action, '.friends-confirm-dialog');
}

async function run() {
  fs.mkdirSync(artifacts, { recursive: true }); fs.mkdirSync(temporary, { recursive: true });
  const frontendPort = await port(), backendPort = await port(), debugPort = await port();
  origin = `http://127.0.0.1:${frontendPort}`; evidence.debugOrigin = `http://127.0.0.1:${debugPort}`;
  backendEnv = { ...process.env, NODE_ENV: 'development', AUTH_ALLOW_HTTP_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: origin,
    HOST: '127.0.0.1', PORT: String(backendPort), DB_PATH: path.join(temporary, 'isolated.sqlite') };
  application = await startServer({ env: backendEnv });
  const out = fs.openSync(path.join(temporary, 'next.stdout.log'), 'w'), err = fs.openSync(path.join(temporary, 'next.stderr.log'), 'w'); descriptors.push(out, err);
  nextProcess = spawn(process.execPath, [path.join(client, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(frontendPort)], {
    cwd: client, windowsHide: true, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', AUTH_BACKEND_URL: `http://127.0.0.1:${backendPort}`, NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true' }, stdio: ['ignore', out, err] });
  children.push(nextProcess); await http(origin + '/login');
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProcess = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(temporary, 'chrome'), 'about:blank'], { windowsHide: true, stdio: 'ignore' }); children.push(chromeProcess);
  await http(evidence.debugOrigin + '/json/version'); const version = await (await fetch(evidence.debugOrigin + '/json/version')).json();
  evidence.browser = version.Browser; evidence.node = process.version; browser = new CDP(version.webSocketDebuggerUrl);
  alice = await isolatedPage(); bob = await isolatedPage();
  await signup(alice, 'alice'); await signup(bob, 'bob'); await login(alice, 'alice'); await login(bob, 'bob');
  await click(alice, '.navigation-profile-button'); await click(alice, '.appearance-options input[value="light"]');
  await textClick(alice, 'Edit profile', '.profile-dialog');
  await input(alice, '#profile-display-name', 'Alice Persisted'); await input(alice, '#profile-status-message', 'Alice private status');
  await click(alice, 'input[name="profile-avatar"][value="rocket"]');
  await alice.eval(`(() => { const e = document.querySelector('#profile-presence'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'busy'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await textClick(alice, 'Save changes', '.profile-dialog'); await wait(alice, `document.querySelector('.profile-summary')?.textContent.includes('Alice Persisted')`, 'saved profile');
  await click(alice, '.profile-dialog button[aria-label="Close profile"]'); await navigate(alice, '/');
  await wait(alice, `document.querySelector('.navigation-profile-name')?.textContent === 'Alice Persisted'`, 'persisted name');
  await click(alice, '.navigation-profile-button');
  check('profile name, avatar, private status and saved preference persist after reload', await alice.eval(`document.querySelector('.profile-dialog')?.textContent.includes('Alice private status') && document.querySelector('.profile-presence-value')?.dataset.presence === 'busy' && document.querySelector('.profile-summary .profile-avatar--rocket') !== null`));
  await screenshot(alice, 'desktop-profile-light.png');
  await click(alice, '.profile-dialog button[aria-label="Close profile"]');
  await search(alice, 'b'); check('one-character search explains prefix minimum', await alice.eval(`document.querySelector('.friends-page')?.textContent.includes('2–64') && !document.querySelector('[aria-label="User search results"]')`));
  await search(alice, 'bo'); await wait(alice, `document.querySelector('[aria-label="User search results"]')?.textContent.includes('@bob')`, 'prefix match');
  check('prefix discovery shows real Bob without private fields or fake presence', await alice.eval(`document.querySelector('[aria-label="User search results"]')?.textContent.includes('@bob') && !document.querySelector('[aria-label="User search results"]')?.textContent.includes('@example.test') && !document.querySelector('[aria-label="User search results"]')?.textContent.includes('Online')`));
  await click(alice, 'button[aria-label="View profile for bob"]'); await wait(alice, `document.querySelector('.friends-profile-identity')?.textContent.includes('@bob')`, 'GET public profile');
  check('public profile exposes no private preferences or email', await alice.eval(`!document.querySelector('.friends-profile-dialog')?.textContent.match(/@example.test|presence preference|status message/i)`));
  await click(alice, '.friends-profile-dialog button[aria-label="Close public profile"]');
  await search(alice, 'zz-no-account'); await wait(alice, `document.querySelector('[role="tabpanel"]:not([hidden]) .friends-empty-heading')?.textContent === 'No matching users'`, 'real empty search');
  await search(alice, 'ali'); await wait(alice, `document.querySelector('[aria-label="User search results"]')?.textContent.includes('This is you')`, 'self result');
  check('self profile cannot receive a request', await alice.eval(`!document.querySelector('button[aria-label="Add Alice Persisted as a friend"]')`));
  await send(); await receive('Accept');
  for (const cdp of [alice, bob]) { await friends(cdp); await refresh(cdp); }
  check('acceptance appears in both real friend lists', await alice.eval(`document.querySelector('[aria-label="Your friends"]')?.textContent.includes('@bob')`) && await bob.eval(`document.querySelector('[aria-label="Your friends"]')?.textContent.includes('@alice')`));
  check('messaging is unavailable for confirmed real friends', await alice.eval(`document.querySelector('button[aria-label="Message bob"]')?.disabled === true`));
  await screenshot(alice, 'desktop-friends-light.png');
  await application.close(); application = await startServer({ env: backendEnv });
  for (const cdp of [alice, bob]) { await navigate(cdp, '/#friends'); await wait(cdp, `document.querySelector('[aria-label="Your friends"]')?.children.length === 1`, 'restart persistence'); }
  check('both sessions and friendship survive real backend restart', true);
  check('Friends deep links keep the Messenger navigation visible', await alice.eval(`document.querySelector('.messenger-navigation')?.getBoundingClientRect().top >= 0 && document.querySelector('.messenger-navigation')?.getBoundingClientRect().bottom < innerHeight`));
  await confirmAction(alice, 'bob', 'Remove friend'); await notice(alice, 'Friend removed.'); await refresh(bob);
  check('remove clears friendship for both accounts', !await alice.eval(`Boolean(document.querySelector('[aria-label="Your friends"]'))`) && !await bob.eval(`Boolean(document.querySelector('[aria-label="Your friends"]'))`));
  await send(); await receive('Decline');
  await send(); await friends(alice, 'Pending Requests'); await click(alice, 'button[aria-label="Cancel request to bob"]'); await notice(alice, 'Friend request canceled.');
  await friends(bob, 'Pending Requests'); await refresh(bob);
  check('decline and sender cancellation remove pending requests', !await bob.eval(`Boolean(document.querySelector('[aria-label="Incoming requests"]'))`));
  await send(); await receive('Accept'); await friends(alice); await refresh(alice);
  await confirmAction(alice, 'bob', 'Block user'); await notice(alice, 'User blocked.');
  await friends(alice, 'Blocked Users'); check('block is authoritative in own blocked list', await alice.eval(`document.querySelector('[aria-label="Blocked users"]')?.textContent.includes('@bob')`));
  await navigate(alice, '/#friends'); await friends(alice, 'Blocked Users');
  await wait(alice, `document.querySelector('[aria-label="Blocked users"]')?.textContent.includes('@bob')`, 'persisted block');
  await search(bob, 'ali'); await wait(bob, `document.querySelector('[role="tabpanel"]:not([hidden]) .friends-empty-heading')?.textContent === 'No matching users'`, 'hidden by block');
  check('block persists and hides profile from blocked peer', true);
  await click(alice, 'button[aria-label="Unblock bob"]'); await notice(alice, 'User unblocked.'); await friends(alice);
  check('unblock never restores a friendship', !await alice.eval(`Boolean(document.querySelector('[aria-label="Your friends"]'))`));
  await search(alice, 'bo'); await screenshot(alice, 'desktop-discovery-light.png');
  await click(alice, '.navigation-profile-button'); await click(alice, '.appearance-options input[value="dark"]');
  await click(alice, '.profile-dialog button[aria-label="Close profile"]');
  await alice.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(250); await screenshot(alice, 'mobile-discovery-dark.png');
  check('mobile dark Friends has visible navigation and no horizontal page overflow', await alice.eval(`document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.dataset.theme === 'dark' && document.querySelector('.messenger-navigation')?.getBoundingClientRect().top >= 0`));
  await click(alice, '.navigation-profile-button'); await screenshot(alice, 'mobile-profile-dark.png');
  check('keyboard focus stays in the open profile dialog', await alice.eval(`Boolean(document.activeElement?.closest('.profile-dialog'))`));
  await click(alice, '.profile-dialog button[aria-label="Close profile"]');
  await click(alice, '.real-account-footer button[aria-label="Sign out"]'); await wait(alice, `location.pathname === '/login'`, 'confirmed logout');
  check('logout removes all account workspace and profile state', await alice.eval(`!document.querySelector('.real-messenger') && !document.body.textContent.includes('Alice private status')`));
  await login(alice, 'bob');
  await wait(alice, `Boolean(document.querySelector('#friends-discovery'))`, 'new account collections loaded');
  check('same browser account switch contains no Alice private profile, search or dialogs', await alice.eval(`!document.body.textContent.includes('Alice private status') && document.querySelector('.navigation-profile-name')?.textContent === 'bob' && !document.querySelector('dialog[open]') && document.querySelector('#friends-discovery')?.value === ''`));
  // Verify server CSRF enforcement via the public origin; the UI never skips this check.
  check('real backend rejects a mutation without CSRF', await alice.eval(`fetch('/api/blocks', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:'unavailable-user'}) }).then(r => r.status === 403)`));
  await application.close(); application = null;
  await search(alice, 'ali'); await wait(alice, `[...document.querySelectorAll('[role="alert"]')].some(e => e.getBoundingClientRect().width && /service|connection|unavailable/i.test(e.textContent))`, 'backend outage safe error');
  check('stopped backend exposes a safe retryable error with no demo fallback', await alice.eval(`!document.body.textContent.match(/Ava Morgan|Kai Chen|SecureBot|database password|SQLITE/) && [...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes('try again'))`));
  await screenshot(alice, 'mobile-backend-unavailable.png');
  check('no unhandled browser runtime exceptions', evidence.runtimeErrors === 0);
  check('real API calls observed for own profile, search, public profile, friends, requests and blocks', ['/api/users/me', '/api/users/search', '/api/friends', '/api/friends/requests', '/api/blocks'].every(p => evidence.network.some(call => call.path === p && [200, 201, 204].includes(call.status))) && evidence.network.some(call => /^\/api\/users\/(?!me|search)/.test(call.path) && call.status === 200));
}

(async () => {
  let failure;
  try { await run(); } catch (error) {
    failure = error; evidence.failure = error.message; console.error(error.message);
    if (alice) try { await screenshot(alice, 'failure.png'); } catch {}
  } finally {
    if (application) await application.close().catch(() => {});
    if (browser) try { await browser.send('Browser.close'); } catch {}
    sockets.forEach(socket => socket.close());
    for (const child of children) if (child.pid && child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    descriptors.forEach(fd => fs.closeSync(fd));
    evidence.completedAt = new Date().toISOString(); evidence.passed = !failure; evidence.cleanup = 'Only owned browser and Next processes stopped; isolated database retained in ignored client/tmp.';
    if (!failure && fs.existsSync(path.join(artifacts, 'failure.png'))) fs.unlinkSync(path.join(artifacts, 'failure.png'));
    delete evidence.debugOrigin;
    fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`${evidence.checks.filter(check => check.passed).length}/${evidence.checks.length} browser assertions passed`);
    process.exitCode = failure ? 1 : 0;
  }
})();
