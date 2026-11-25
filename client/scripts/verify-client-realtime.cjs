/* Real browser/UI + same-origin Next proxy + genuine DATA verifier. Isolated processes only. */
// Pass --local-delete-only for the focused account-local deletion acceptance checks.
// --local-delete-and-key-review also runs the later new-device scenarios after re-login.
// Pass --reply-forward-only for encrypted reply/forward and partial-failure checks.
// Pass --unsend-only for authenticated Unsend, history and failure-recovery checks.
// Pass --edit-only for authenticated signed encrypted revisions (the former --edit-unavailable-only flag is an alias).
// Pass --pins-only for shared authenticated pinning, local-hide and recovery checks.
// Pass --a2-only for cached pin replays after another real tab advances shared IndexedDB watermarks.
// Pass --reactions-only for shared authenticated reactions and recovery checks.
// Pass --attachments-only for encrypted file transfer, real media previews and lifecycle checks.
// Pass --voice-only for real microphone recording and encrypted voice delivery using a synthetic browser microphone.
// Pass --calls-unavailable-only for the production fail-closed calling gate; this does not test media transport.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium, expect } = require('@playwright/test');
const { io } = require('socket.io-client');
const {webmFromWebP}=require('../test/encryptedVideoFixture.cjs');
const root = path.resolve(__dirname, '..'), suffix = randomUUID().slice(0, 8);
const temporary = path.join(root, 'tmp', 'client-realtime-' + suffix), artifacts = path.join(temporary, 'artifacts');
const children = [], pages = [], secretTexts = ['Alice live E2EE 👩🏽‍💻\nMultiline ', 'Bob live reply ', 'New device epoch ', 'Offline gap ', 'Restart live ', 'REST fallback ', 'Same account device ', 'Background delivered ', 'Draft to Bob ', 'Draft to Charlie ', 'While in Meeting Rooms ', 'Mobile draft '].map(t => t + suffix);
const evidence = { startedAt: new Date().toISOString(), checks: [], network: [], plaintextLeaks: 0, runtimeErrors: 0, browser: 'Chrome, separate isolated contexts', screenshots: [], handshakes: 0, invalidAuthShapes: 0, socketSends: 0, v2Sends: 0, restSends: 0, persistenceAcks: 0, receivedMessages: 0 };
secretTexts.push(...['Local hidden outgoing ', 'Local hidden incoming ', 'After local hiding '].map(text => text + suffix));
secretTexts.push(...['Reply to received message 👩🏽‍💻\n', 'Reply to own sent message ', 'Reply during offline gap ', 'Forward optional private note ', 'Live forward note '].map(text => text + suffix));
secretTexts.push(...['Reply to an unsent original ', 'Unsend during offline gap ', 'Unsend request failure ', 'Unsend lost response '].map(text => text + suffix));
secretTexts.push('Pinned across offline gap ' + suffix);
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
        if (data[0] === 'message:deleted') { evidence.deletionHints ??= []; evidence.deletionHints.push({ page: pages.indexOf(page), keys: Object.keys(data[1]).sort(), conversationId: data[1].conversationId, messageId: data[1].messageId }); }
        if (data[0] === 'conversation:pins-changed') { evidence.pinHints ??= []; evidence.pinHints.push({ page: pages.indexOf(page), keys: Object.keys(data[1]).sort(), conversationId: data[1].conversationId }); }
        if(data[0]==='message:reactions-changed'){evidence.reactionHints??=[];evidence.reactionHints.push({page:pages.indexOf(page),keys:Object.keys(data[1]).sort(),conversationId:data[1].conversationId});}
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
async function refresh(page) { await advanced(page); await page.getByRole('button', { name: 'Refresh secure conversation', exact: true }).click(); await ready(page); await page.getByText('Advanced settings', { exact: true }).press('Enter'); }
async function ready(page) { await expect(page.getByText('Secure message ready', { exact: true })).toBeVisible({ timeout: 45000 }); await expect(page.getByRole('textbox', { name: /^Message to / })).toBeEnabled(); }
async function select(page, name) { await expect(page.locator('.conversation-sidebar')).toHaveCount(1, { timeout: 45000 }); if (!await page.getByRole('navigation', { name: 'Direct conversations' }).isVisible()) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click(); await page.getByRole('button', { name: 'Refresh conversations', exact: true }).click(); await page.getByRole('navigation', { name: 'Direct conversations' }).getByRole('button', { name: new RegExp('^' + name + ',') }).click(); await ready(page); }
async function send(page, text) { await page.getByRole('textbox', { name: /^Message to / }).fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.getByRole('log').getByText(text, { exact: true })).toBeVisible({ timeout: 30000 }); }
async function localDeleteReview(page, text) {
  const row = page.getByRole('log').locator('article').filter({ has: page.getByText(text, { exact: true }) });
  await row.hover(); await row.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const review = page.getByRole('dialog'); await expect(review).toBeVisible();
  await review.getByRole('radio', { name: /Delete for you/ }).check();
  await expect(review.getByRole('radio', { name: /Delete for you/ })).toBeChecked();
  await expect(review.getByText(/removed from your device.*visible to other chat members/)).toBeVisible();
  return { row, review };
}
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
    host = await chromium.launchPersistentContext(path.join(temporary, 'chrome'), { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, viewport: { width: 1440, height: 1000 },...(process.argv.includes('--voice-only')?{args:['--use-fake-device-for-media-stream']}:{}) });
    const browser = host.browser(), a = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), b = await browser.newContext(), c = await browser.newContext();
    const alice = await a.newPage(), bob = await b.newPage(), charlie = await c.newPage(); [alice, bob, charlie].forEach(monitor);
    if(process.argv.includes('--calls-unavailable-only'))for(const page of [alice,bob])await page.addInitScript(()=>{
      window.__callCaptureAttempts=0;
      const native=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
      if(native)navigator.mediaDevices.getUserMedia=options=>{window.__callCaptureAttempts++;return native(options);};
    });
    if(process.argv.includes('--voice-only')){await a.grantPermissions(['microphone'],{origin});await b.grantPermissions(['microphone'],{origin});}
    if(process.argv.includes('--attachments-only')||process.argv.includes('--voice-only'))for(const page of process.argv.includes('--voice-only')?[alice,bob]:[alice])await page.addInitScript(()=>{
      const native=window.fetch.bind(window);window.__encryptedUploadChecks=[];
      window.fetch=async(input,init)=>{
        if(init?.method==='POST'&&String(input).startsWith('/api/attachments?')){
          const bytes=init.body instanceof Blob?Array.from(new Uint8Array(await init.body.arrayBuffer())):null;
          window.__encryptedUploadChecks.push({url:String(input),bytes});
        }
        return native(input,init);
      };
      window.__voiceTracks=[];const getMedia=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
      if(getMedia)navigator.mediaDevices.getUserMedia=async options=>{const stream=await getMedia(options);window.__voiceTracks.push(...stream.getTracks());return stream;};
    });
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
    await emojiDraft.fill('Keep middle text\n' + secretTexts[0]); await emojiDraft.evaluate(node => node.setSelectionRange(5, 11));
    await alice.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    await expect(alice.getByRole('tab')).toHaveCount(10);
    for (const label of ['Smileys', 'People', 'Animals', 'Food', 'Activities', 'Travel', 'Objects', 'Symbols', 'Flags']) {
      await alice.getByRole('tab', { name: label, exact: true }).click();
      await expect(alice.getByRole('tabpanel', { name: label, exact: true }).getByRole('button').first()).toBeVisible();
    }
    check('real-account picker exposes all nine existing Unicode categories', true);
    await alice.getByRole('searchbox', { name: 'Search emoji' }).fill('pizza');
    await alice.getByRole('searchbox', { name: 'Search emoji' }).press('ArrowDown'); await alice.keyboard.press('Enter');
    await expect(emojiDraft).toHaveValue('Keep 🍕 text\n' + secretTexts[0]); await expect(emojiDraft).toBeFocused();
    check('real-account composer preserves cursor selection through the advanced emoji picker', true);
    await alice.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    await expect(alice.getByRole('tab', { name: 'Recently Used', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(alice.getByRole('button', { name: 'Insert pizza 🍕', exact: true })).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Search emoji' }).fill('vietnam');
    await alice.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳', exact: true }).click();
    secretTexts[0] = 'Keep 🍕🇻🇳 text\n' + secretTexts[0];
    await expect(emojiDraft).toHaveValue(secretTexts[0]); await expect(emojiDraft).toBeFocused();
    check('real-account recents and name search insert Unicode without replacing surrounding multiline text', true);
    await alice.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(alice.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(bob.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible({ timeout: 30000 }); check('Bob receives and locally decrypts Alice live picker-composed multiline Unicode message without Refresh', true);
    await alice.getByRole('log').locator('article').first().hover();
    await alice.getByRole('button', { name: 'More actions', exact: true }).click();
    check('real-account menu exposes only integrated actions including encrypted Edit',
      JSON.stringify((await alice.getByRole('menuitem').allTextContents()).map(text => text.trim())) === JSON.stringify(['Forward', 'Pin', 'Edit', 'Delete']) &&
      await alice.getByRole('button', { name: 'Reply', exact: true }).count() === 1 && await alice.getByRole('button', { name: 'React to message', exact: true }).count() === 1);
    await alice.keyboard.press('Escape');
    await send(bob, secretTexts[1]); await expect(alice.getByRole('log').getByText(secretTexts[1], { exact: true })).toBeVisible({ timeout: 30000 }); check('Alice receives and locally decrypts Bob live reply without Refresh', true);
    await expect(alice.getByRole('log').getByText('Read', { exact: true })).toBeVisible({ timeout: 15000 }); check('DATA-backed read receipt is distinct from persistence', true);
    if(process.argv.includes('--calls-unavailable-only')){
      for(const page of [alice,bob]){
        await expect(page.getByRole('group',{name:'Direct call actions'})).toHaveCount(0);
        check('unverified real media leaves call controls unavailable',true);
        const denied=await api(page,'/api/calls/token','POST',{callId:randomUUID(),connectionId:'no-active-call'});
        check('same-origin DATA call token route refuses unavailable LiveKit',denied.status===503);
        check('idle authenticated calling never requests a microphone or camera',await page.evaluate(()=>window.__callCaptureAttempts===0));
      }
      const unauthenticated=await fetch(origin+'/api/calls/token',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
      check('same-origin token proxy preserves authentication',unauthenticated.status===401);
      const noCsrf=await alice.evaluate(async()=> (await fetch('/api/calls/token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status);
      check('same-origin token proxy preserves CSRF refusal',noCsrf===403);
      await alice.reload();await select(alice,'Bob');await connected(alice);
      await expect(alice.getByRole('group',{name:'Direct call actions'})).toHaveCount(0);
      check('reload keeps authenticated calls gated and encrypted history readable',await alice.getByRole('log').getByText(secretTexts[1],{exact:true}).count()===1);
      await alice.context().setOffline(true);await delay(600);await alice.context().setOffline(false);await connected(alice);
      await send(alice,secretTexts[3]);await expect(bob.getByRole('log').getByText(secretTexts[3],{exact:true})).toHaveCount(1);
      check('existing encrypted messaging survives the call runtime and reconnect',true);
      await alice.getByRole('button',{name:'Open Voice Rooms',exact:true}).click();
      await expect(alice.getByRole('region',{name:'Voice rooms',exact:true})).toBeVisible();
      await expect(alice.getByRole('log')).toHaveCount(0);
      await alice.getByRole('button',{name:'Back to account',exact:true}).click();await connected(alice);
      await expect(alice.getByRole('log').getByText(secretTexts[3],{exact:true})).toHaveCount(1);
      check('Voice Rooms navigation preserves messaging and keeps direct-call capture disabled',await alice.evaluate(()=>window.__callCaptureAttempts===0));
      await alice.setViewportSize({width:390,height:844});
      check('workspace retains mobile layout without overflow',await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      check('no plaintext message leak or browser runtime exception',evidence.plaintextLeaks===0&&evidence.runtimeErrors===0);
      check('authenticated socket handshakes retain the exact CSRF contract',evidence.handshakes>=2&&evidence.invalidAuthShapes===0);
      evidence.mediaVerified=false;evidence.mediaBlocker='No configured LiveKit server or credentials; controls remain disabled.';
      evidence.passed=true;evidence.nextStartupHealthy=next.exitCode===null;evidence.backendHealthy=backend.exitCode===null;return;
    }
    if(process.argv.includes('--voice-only')){
      const cid=(await api(alice,'/api/conversations?limit=50')).body.items[0].id;
      const history=async page=>(await api(page,`/api/conversations/${cid}/messages?limit=50`)).body.items;
      const row=(page,id)=>page.getByRole('log').locator(`[data-message-id="${id}"]`);
      const uploads=async page=>(await page.evaluate(()=>window.__encryptedUploadChecks)).map(r=>({...r,bytes:r.bytes?Buffer.from(r.bytes):null}));
      const ended=async page=>page.evaluate(()=>window.__voiceTracks.length>0&&window.__voiceTracks.every(track=>track.readyState==='ended'));
      const record=async page=>{
        await page.bringToFront();await page.getByRole('button',{name:'Record voice message',exact:true}).click();
        await expect(page.getByRole('button',{name:'Stop voice recording',exact:true})).toBeVisible().catch(async error=>{evidence.recordingFailure=await page.evaluate(async()=>({text:document.querySelector('.message-composer')?.innerText,recorder:typeof MediaRecorder,permission:(await navigator.permissions.query({name:'microphone'})).state}));throw error;});await delay(1600);
        await page.getByRole('button',{name:'Stop voice recording',exact:true}).click();
        const preview=page.getByLabel('Recorded voice preview',{exact:true});await expect(preview).toBeVisible();
        await expect.poll(()=>ended(page)).toBe(true);
        const bytes=await preview.evaluate(async audio=>Array.from(new Uint8Array(await (await fetch(audio.src)).arrayBuffer())));
        await preview.evaluate(audio=>{audio.muted=true;return audio.play();});await expect.poll(()=>preview.evaluate(audio=>audio.currentTime)).toBeGreaterThan(0);await preview.evaluate(audio=>audio.pause());
        return {bytes:Buffer.from(bytes),url:await preview.getAttribute('src')};
      };
      const play=async(page,id,sender)=>{
        await page.bringToFront();const player=row(page,id).getByLabel('Voice message from '+sender,{exact:true});await expect(player).toBeVisible({timeout:30000});
        await expect(player).toHaveAttribute('controls','');await player.scrollIntoViewIfNeeded();
        await player.evaluate(audio=>{audio.muted=true;return audio.play();});await expect.poll(()=>player.evaluate(audio=>audio.currentTime)).toBeGreaterThan(0.05);await player.evaluate(audio=>{audio.pause();audio.currentTime=0.1;});await expect.poll(()=>player.evaluate(audio=>audio.seeking)).toBe(false);
        return player.evaluate(async audio=>({url:audio.src,bytes:Array.from(new Uint8Array(await (await fetch(audio.src)).arrayBuffer()))}));
      };
      const first=await record(alice);check('real microphone APIs record, preview and release all tracks before upload',true);
      const firstCaption='Encrypted voice '+suffix;secretTexts.push(firstCaption);await send(alice,firstCaption);
      const original=(await history(alice))[0],firstReceived=await play(bob,original.id,'Alice');
      check('recipient decrypts and plays the exact recording using a new local Blob URL',Buffer.from(firstReceived.bytes).equals(first.bytes)&&firstReceived.url!==first.url);
      const aUploads=await uploads(alice);const fileId=new URL(aUploads[0].url,origin).searchParams.get('id');
      check('voice storage upload contains ciphertext rather than the recorded audio',aUploads.length===1&&aUploads[0].bytes.length===first.bytes.length+16&&!aUploads[0].bytes.equals(first.bytes)&&!aUploads[0].url.includes('blob:'));
      check('voice delivery preserves the existing V2 text envelope contract',original.type==='text'&&original.encryption.version===2&&!JSON.stringify(original).includes('blob:'));
      check('outsiders cannot download encrypted voice recordings',(await api(charlie,`/api/attachments/${fileId}/download`)).status===404);
      await bob.route(`**/api/attachments/${fileId}/download`,async route=>{const response=await route.fetch(),body=Buffer.from(await response.body());body[0]^=1;await route.fulfill({response,body});});
      await bob.reload();await select(bob,'Alice');await expect(row(bob,original.id).getByRole('alert')).toContainText('integrity',{timeout:30000});await expect(row(bob,original.id).locator('audio')).toHaveCount(0);check('corrupted ciphertext is rejected before a playback URL is exposed',true);
      await bob.unroute(`**/api/attachments/${fileId}/download`);await row(bob,original.id).getByRole('button',{name:'Retry voice message',exact:true}).click();await play(bob,original.id,'Alice');check('voice download retry repeats authenticated decryption without a reload',true);
      await bob.reload();await select(bob,'Alice');await play(bob,original.id,'Alice');check('reload restores encrypted voice playback',true);
      await bob.getByText('Advanced settings',{exact:true}).click();await bob.getByRole('button',{name:'Reconnect live',exact:true}).click();await connected(bob);await play(bob,original.id,'Alice');check('reconnect restores voice playback',true);
      await bob.getByRole('button',{name:/^Open profile for Bob/}).click();await bob.getByRole('dialog',{name:'Your profile',exact:true}).getByRole('button',{name:'Sign Out',exact:true}).click();await login(bob,origin,usernames[1],password);await select(bob,'Alice');await play(bob,original.id,'Alice');check('logout/login preserves enrolled keys and encrypted voice history',true);
      const reply=await record(bob),replyCaption='Bob encrypted voice '+suffix;secretTexts.push(replyCaption);await send(bob,replyCaption);const replyMessage=(await history(bob))[0],replyReceived=await play(alice,replyMessage.id,'Bob');check('both authenticated accounts can record, send, decrypt and play voice',Buffer.from(replyReceived.bytes).equals(reply.bytes));
      await alice.bringToFront();await alice.getByRole('button',{name:'Record voice message',exact:true}).click();await expect(alice.getByRole('button',{name:'Cancel voice recording',exact:true})).toBeVisible();await alice.getByRole('button',{name:'Cancel voice recording',exact:true}).click();await expect.poll(()=>ended(alice)).toBe(true);await expect(alice.getByLabel('Recorded voice preview')).toHaveCount(0);check('cancel stops the microphone without producing a sendable recording',true);
      await alice.getByRole('button',{name:'Record voice message',exact:true}).click();await expect(alice.getByRole('button',{name:'Stop voice recording',exact:true})).toBeVisible();await alice.getByRole('button',{name:/^Friends(?:,|$)/}).click();await expect.poll(()=>ended(alice)).toBe(true);await alice.getByRole('button',{name:'Chats',exact:true}).click();await select(alice,'Bob');check('navigation cancels microphone capture safely',true);
      const discarded=await record(alice);await alice.getByRole('button',{name:'Remove recorded voice',exact:true}).click();check('removing a recording revokes its preview URL',await alice.evaluate(url=>fetch(url).then(()=>false,()=>true),discarded.url));
      const cdp=await a.newCDPSession(alice),target=(await cdp.send('Target.getTargetInfo')).targetInfo;
      await cdp.send('Browser.setPermission',{permission:{name:'microphone'},setting:'denied',origin,browserContextId:target.browserContextId});
      await alice.getByRole('button',{name:'Record voice message',exact:true}).click();await expect(alice.locator('.message-composer').getByRole('alert')).toContainText('Allow the microphone and try again');await expect(alice.getByLabel('Recorded voice preview')).toHaveCount(0);check('native microphone permission denial has actionable feedback',true);
      await cdp.send('Browser.setPermission',{permission:{name:'microphone'},setting:'granted',origin,browserContextId:target.browserContextId});await cdp.detach();
      await alice.evaluate(()=>{window.__savedRecorder=window.MediaRecorder;window.MediaRecorder=undefined;});await alice.getByRole('button',{name:'Record voice message',exact:true}).click();await expect(alice.locator('.message-composer').getByRole('alert')).toContainText('cannot record audio');await alice.evaluate(()=>{window.MediaRecorder=window.__savedRecorder;});check('unsupported recording APIs fail without a plaintext fallback',true);
      await a.grantPermissions(['microphone'],{origin});await alice.reload();await select(alice,'Bob');
      const beforeRetry=(await uploads(alice)).length;
      const retryRecording=await record(alice);let lost=false;await alice.route('**/api/attachments?**',async route=>{if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
      const retryCaption='Voice upload retry '+suffix;secretTexts.push(retryCaption);await alice.getByRole('textbox',{name:/^Message to /}).fill(retryCaption);await alice.getByRole('button',{name:'Send',exact:true}).click();await expect(alice.locator('.message-composer').getByRole('alert')).toContainText('draft is still here');await expect(alice.getByLabel('Recorded voice preview')).toBeVisible();await alice.getByRole('button',{name:'Send',exact:true}).click();await expect(bob.getByRole('log').getByText(retryCaption,{exact:true})).toBeVisible({timeout:30000});await alice.unroute('**/api/attachments?**');
      const retried=(await uploads(alice)).slice(beforeRetry);check('failed voice uploads preserve the preview and reuse exact ciphertext on retry',retried.length===2&&retried[0].url===retried[1].url&&retried[0].bytes.equals(retried[1].bytes));const retriedMessage=(await history(alice))[0],retriedAudio=await play(bob,retriedMessage.id,'Alice');check('retried voice is delivered once and decrypts correctly',Buffer.from(retriedAudio.bytes).equals(retryRecording.bytes));
      await alice.bringToFront();await alice.getByText('Advanced settings',{exact:true}).click();await alice.getByLabel('Message transport',{exact:true}).selectOption('rest');await record(alice);
      let ackLost=false;await alice.route('**/api/conversations/*/messages',async route=>{if(route.request().method()==='POST'&&!ackLost){ackLost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
      const uncertainCaption='Voice message retry '+suffix;secretTexts.push(uncertainCaption);await alice.getByRole('textbox',{name:/^Message to /}).fill(uncertainCaption);await alice.getByRole('button',{name:'Send',exact:true}).click();await expect(alice.getByRole('button',{name:'Reconcile or retry pending message',exact:true})).toBeVisible({timeout:30000});await alice.unroute('**/api/conversations/*/messages');await alice.getByRole('button',{name:'Reconcile or retry pending message',exact:true}).click();await expect(alice.getByRole('log').getByText(uncertainCaption,{exact:true})).toHaveCount(1);await expect(alice.getByRole('button',{name:'Reconcile or retry pending message',exact:true})).toHaveCount(0);check('uncertain voice message confirmation reconciles without duplication',true);
      await b.setOffline(true);await record(alice);const offlineCaption='Offline voice '+suffix;secretTexts.push(offlineCaption);await send(alice,offlineCaption);const offlineMessage=(await history(alice))[0];await b.setOffline(false);await bob.reload();await select(bob,'Alice');await play(bob,offlineMessage.id,'Alice');check('offline recipients recover and play voice from encrypted history',true);
      await alice.bringToFront();const menu=row(alice,original.id).getByRole('button',{name:'More actions',exact:true});await menu.scrollIntoViewIfNeeded();await menu.focus();await menu.press('Enter');await expect(alice.getByRole('menu')).toBeVisible();await expect(alice.getByRole('menuitem',{name:'Forward',exact:true})).toHaveCount(0);check('voice forwarding remains unavailable',true);
      await alice.getByRole('menuitem',{name:'Delete',exact:true}).click();await alice.getByRole('dialog').getByRole('button',{name:'Delete',exact:true}).click();await expect(row(bob,original.id).locator('audio')).toHaveCount(0,{timeout:30000});check('Unsend invalidates voice download access',(await api(bob,`/api/attachments/${fileId}/download`)).status===404);await bob.reload();await select(bob,'Alice');await expect(row(bob,original.id).locator('audio')).toHaveCount(0);check('Unsend tombstones and voice removal survive reload',true);
      check('all microphone tracks are ended',await alice.evaluate(()=>window.__voiceTracks.every(track=>track.readyState==='ended'))&&await bob.evaluate(()=>window.__voiceTracks.every(track=>track.readyState==='ended')));check('no monitored messaging plaintext leaks',evidence.plaintextLeaks===0);check('no browser runtime exceptions',evidence.runtimeErrors===0);evidence.passed=true;console.log('PASS encrypted voice browser checks');return;
    }
    if(process.argv.includes('--attachments-only')){
      const cid=(await api(alice,'/api/conversations?limit=50')).body.items[0].id;
      const sent=[];
      const wireUploads=async()=> (await alice.evaluate(()=>window.__encryptedUploadChecks)).map(r=>({...r,bytes:r.bytes?Buffer.from(r.bytes):null}));
      alice.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/attachments')sent.push({url:request.url(),bytes:request.postDataBuffer(),headers:request.headers()});});
      await alice.bringToFront();
      const image=await alice.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle='#582098';ctx.fillRect(0,0,16,16);return canvas.toDataURL('image/png').split(',')[1];});
      const video=webmFromWebP(Buffer.from(await alice.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#582098';ctx.fillRect(0,0,64,64);return canvas.toDataURL('image/webp',0.5).split(',')[1];}),'base64'));
      const pdf=(()=>{const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];let text='%PDF-1.4\n',offsets=[0];objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${s}\nendobj\n`;});const xref=Buffer.byteLength(text);text+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(text);})();
      const docx=(()=>{
        const entries={'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Private encrypted Word document</w:t></w:r></w:p></w:body></w:document>'};
        let offset=0;const chunks=[],central=[];
        const crc=b=>{let c=0xffffffff;for(const byte of b){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
        for(const [name,text]of Object.entries(entries)){const n=Buffer.from(name),b=Buffer.from(text),h=Buffer.alloc(30),c=Buffer.alloc(46);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc(b),14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);
          c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc(b),16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);chunks.push(h,n,b);central.push(c,n);offset+=h.length+n.length+b.length;}
        const end=Buffer.alloc(22),index=Buffer.concat(central);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,index,end]);
      })();
      const selected=[{name:'private-image-'+suffix+'.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')},
        {name:'private-video-'+suffix+'.webm',mimeType:'video/webm',buffer:video},
        {name:'private-report-'+suffix+'.pdf',mimeType:'application/pdf',buffer:pdf},
        {name:'private-document-'+suffix+'.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx}];
      await expect(alice.getByRole('button',{name:'Attach files or images',exact:true})).toBeEnabled();
      await alice.getByLabel('Select attachments').setInputFiles(selected);
      for(const file of selected)await expect(alice.getByRole('button',{name:'Remove '+file.name,exact:true})).toBeVisible();
      check('real-account composer reuses multi-file selection and upload previews',true);
      const caption='Encrypted media '+suffix;secretTexts.push(caption);await send(alice,caption);
      const row=page=>page.getByRole('log').locator('article').filter({hasText:caption});
      await expect(row(bob)).toHaveCount(1,{timeout:30000});
      await bob.bringToFront();await row(bob).locator('.message-attachment-image').scrollIntoViewIfNeeded();
      await expect.poll(()=>row(bob).locator('.message-attachment-image').evaluate(node=>node.complete&&node.naturalWidth>0),{timeout:15000}).toBe(true).catch(async error=>{
        evidence.attachmentRendering=await row(bob).evaluate(async node=>({text:node.innerText,images:await Promise.all(Array.from(node.querySelectorAll('img')).map(async img=>({src:img.getAttribute('src'),complete:img.complete,width:img.naturalWidth,bytes:await fetch(img.src).then(r=>r.arrayBuffer()).then(b=>({size:b.byteLength,head:Array.from(new Uint8Array(b).slice(0,16))})).catch(()=>null)})))}));throw error;
      });
      await row(bob).getByRole('button',{name:'Preview '+selected[0].name,exact:true}).click();
      await expect(bob.getByRole('dialog',{name:selected[0].name,exact:true}).locator('img')).toBeVisible();await bob.getByRole('button',{name:'Close attachment preview',exact:true}).click();
      check('recipient decrypts a real PNG and opens the shared image lightbox',true);
      const player=row(bob).locator('video');await player.scrollIntoViewIfNeeded();await expect.poll(()=>player.evaluate(node=>node.readyState),{timeout:15000}).toBeGreaterThanOrEqual(2).catch(async error=>{evidence.videoRendering=await player.evaluate(async node=>({error:node.error?.message,code:node.error?.code,state:node.networkState,src:node.currentSrc,ready:node.readyState,bytes:await fetch(node.currentSrc).then(r=>r.arrayBuffer()).then(b=>({size:b.byteLength,head:Array.from(new Uint8Array(b).slice(0,16))})).catch(()=>null)}));throw error;});
      await player.evaluate(node=>{node.muted=true;return node.play();});await expect.poll(()=>player.evaluate(node=>node.currentTime)).toBeGreaterThan(0);await player.evaluate(node=>node.pause());
      check('recipient decrypts and plays a real WebM video',true);
      await row(bob).getByRole('button',{name:'Preview '+selected[2].name,exact:true}).click();
      await expect(bob.getByRole('dialog',{name:selected[2].name,exact:true})).toBeVisible();await bob.getByRole('button',{name:'Close attachment preview',exact:true}).click();
      check('recipient opens the shared PDF preview with verified decrypted bytes',true);
      const downloadFile=async(page,file)=>{const pendingDownload=page.waitForEvent('download');await row(page).getByRole('link',{name:'Download '+file.name,exact:true}).click();const download=await pendingDownload;check('authorized download preserves '+file.mimeType,download.suggestedFilename()===file.name&&fs.readFileSync(await download.path()).equals(file.buffer));};
      for(const file of selected)await downloadFile(bob,file);
      const firstHistory=(await api(alice,`/api/conversations/${cid}/messages?limit=50`)).body.items,stored=firstHistory.find(m=>!firstHistory.filter(x=>x.sequence>m.sequence).length);
      const encryptedUploads=await wireUploads();
      check('uploads contain ciphertext only and no original filename headers',sent.length===4&&encryptedUploads.length===4&&sent.every((r,i)=>r.headers['content-type']==='application/octet-stream'&&!r.headers['x-file-name']&&!r.headers['x-file-key']&&encryptedUploads[i].bytes&&!encryptedUploads[i].bytes.equals(selected[i].buffer)&&encryptedUploads[i].bytes.length===selected[i].buffer.length+16));
      check('outsiders cannot download encrypted conversation files',(await api(charlie,`/api/attachments/${new URL(sent[0].url).searchParams.get('id')}/download`)).status===404);
      await row(alice).hover();await row(alice).getByRole('button',{name:'More actions',exact:true}).click();await expect(alice.getByRole('menuitem',{name:'Forward',exact:true})).toHaveCount(0);await alice.keyboard.press('Escape');check('encrypted media forwarding remains unavailable',true);
      await bob.reload();await select(bob,'Alice');await downloadFile(bob,selected[3]);check('reload restores protected file manifests and downloads',true);
      await bob.getByText('Advanced settings',{exact:true}).click();await bob.getByRole('button',{name:'Reconnect live',exact:true}).click();await connected(bob);await downloadFile(bob,selected[0]);check('reconnection restores authenticated attachment access',true);
      await bob.getByRole('button',{name:/^Open profile for Bob/}).click();await bob.getByRole('dialog',{name:'Your profile',exact:true}).getByRole('button',{name:'Sign Out',exact:true}).click();
      await login(bob,origin,usernames[1],password);await select(bob,'Alice');await downloadFile(bob,selected[3]);check('logout and login preserve the enrolled device and encrypted file history',true);
      let uploadLost=false;
      await alice.route('**/api/attachments?**',async route=>{if(!uploadLost){uploadLost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
      const retryCaption='Attachment upload retry '+suffix;secretTexts.push(retryCaption);
      await alice.getByLabel('Select attachments').setInputFiles(selected[2]);await alice.getByRole('textbox',{name:/^Message to /}).fill(retryCaption);await alice.getByRole('button',{name:'Send',exact:true}).click();
      await expect(alice.getByRole('button',{name:'Send',exact:true})).toBeEnabled();await alice.getByRole('button',{name:'Send',exact:true}).click();await expect(bob.getByRole('log').getByText(retryCaption,{exact:true})).toBeVisible({timeout:30000});
      const retries=(await wireUploads()).slice(4);check('uncertain upload retries reuse the same identifier and ciphertext',retries.length===2&&retries[0].url===retries[1].url&&retries[0].bytes.equals(retries[1].bytes));await alice.unroute('**/api/attachments?**');
      await alice.getByText('Advanced settings',{exact:true}).click();await alice.getByLabel('Message transport',{exact:true}).selectOption('rest');
      let messageLost=false;await alice.route('**/api/conversations/*/messages',async route=>{if(route.request().method()==='POST'&&!messageLost){messageLost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
      const uncertainCaption='Attachment message retry '+suffix;secretTexts.push(uncertainCaption);await alice.getByLabel('Select attachments').setInputFiles(selected[3]);await alice.getByRole('textbox',{name:/^Message to /}).fill(uncertainCaption);await alice.getByRole('button',{name:'Send',exact:true}).click();
      await expect(alice.getByRole('button',{name:'Reconcile or retry pending message',exact:true})).toBeVisible({timeout:30000});await alice.unroute('**/api/conversations/*/messages');await alice.getByRole('button',{name:'Reconcile or retry pending message',exact:true}).click();await expect(alice.getByRole('log').getByText(uncertainCaption,{exact:true})).toHaveCount(1);await expect(alice.getByRole('button',{name:'Reconcile or retry pending message',exact:true})).toHaveCount(0);check('lost message confirmation reconciles without a duplicate attachment message',true);
      await b.setOffline(true);const offlineCaption='Offline attachment '+suffix;secretTexts.push(offlineCaption);await alice.getByLabel('Select attachments').setInputFiles(selected[0]);await send(alice,offlineCaption);await b.setOffline(false);await bob.reload();await select(bob,'Alice');await expect(bob.getByRole('log').getByText(offlineCaption,{exact:true})).toBeVisible({timeout:30000});check('offline recipient restores encrypted attachment messages from history',true);
      await alice.bringToFront();const unsendTrigger=row(alice).getByRole('button',{name:'More actions',exact:true});await unsendTrigger.scrollIntoViewIfNeeded();await unsendTrigger.focus();await unsendTrigger.press('Enter');
      await expect(alice.getByRole('menu')).toBeVisible();evidence.attachmentUnsendMenu=(await alice.getByRole('menuitem').allTextContents()).map(s=>s.trim());
      await alice.getByRole('menuitem',{name:'Delete',exact:true}).click();await alice.getByRole('dialog').getByRole('button',{name:'Delete',exact:true}).click();
      await expect(row(bob)).toHaveCount(0,{timeout:30000});
      check('Unsend invalidates subsequent authorized downloads',(await api(bob,`/api/attachments/${new URL(sent[0].url).searchParams.get('id')}/download`)).status===404);
      await bob.reload();await select(bob,'Alice');check('Unsend history remains a tombstone without attachment cards',(await api(bob,`/api/conversations/${cid}/messages?limit=50`)).body.items.find(m=>m.id===stored.id)?.state==='deleted');
      check('no plaintext messaging crossed monitored transports',evidence.plaintextLeaks===0);check('no browser runtime exceptions',evidence.runtimeErrors===0);
      evidence.passed=true;console.log('PASS encrypted attachment browser checks');return;
    }
    if(process.argv.includes('--reactions-only')){
      const cid=(await api(alice,'/api/conversations?limit=50')).body.items[0].id;
      const history=async()=>(await api(alice,`/api/conversations/${cid}/messages?limit=50`)).body.items;
      const original=(await history()).find(m=>m.senderId===accounts[0].id);
      const row=page=>page.getByRole('log').locator(`[data-message-id="${original.id}"]`);
      const badge=(page,emoji,count=1)=>row(page).getByRole('button',{name:emoji+' '+count,exact:true});
      const openReactions=async page=>{
        await page.bringToFront();const trigger=row(page).getByRole('button',{name:'React to message',exact:true});
        await expect(trigger).toBeEnabled();await trigger.focus();await trigger.press('Enter');
      };
      const quick=async(page,emoji)=>{await openReactions(page);await page.getByRole('menuitemcheckbox',{name:'React '+emoji,exact:true}).click();};
      const full=async(page,query,label)=>{
        await openReactions(page);
        await page.getByRole('menuitem',{name:'More reactions',exact:true}).click();await page.getByRole('searchbox',{name:'Search emoji'}).fill(query);await page.getByRole('button',{name:'React with '+label,exact:true}).click();
      };
      await openReactions(alice);await openReactions(bob);
      await Promise.all([alice.getByRole('menuitemcheckbox',{name:'React 👍',exact:true}).click(),bob.getByRole('menuitemcheckbox',{name:'React 👍',exact:true}).click()]);
      for(const page of [alice,bob]){await expect(badge(page,'👍',2)).toBeVisible();await expect(badge(page,'👍',2)).toHaveAttribute('aria-pressed','true');}
      check('two authenticated users can react concurrently and see an accurate shared count',true);
      await full(alice,'pizza','pizza 🍕');
      for(const page of [alice,bob]){await expect(badge(page,'👍')).toBeVisible();await expect(badge(page,'🍕')).toBeVisible();}
      await expect(badge(alice,'🍕')).toHaveAttribute('aria-pressed','true');await expect(badge(bob,'🍕')).toHaveAttribute('aria-pressed','false');
      check('full picker replacement preserves one active reaction per user and the other participant reaction',true);
      await badge(alice,'🍕').click();for(const page of [alice,bob])await expect(badge(page,'🍕')).toHaveCount(0);
      await badge(bob,'👍').click();for(const page of [alice,bob])await expect(badge(page,'👍')).toHaveCount(0);
      check('clicking a selected reaction removes only the current user choice',true);
      const routePath='**/api/messages/'+original.storageId+'/reaction';let release,seen,count=0;
      const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{seen=resolve;});
      await alice.route(routePath,async route=>{count++;seen();await gate;await route.continue();});
      await quick(alice,'❤️');await Promise.race([started,delay(15000).then(()=>{throw Error('Reaction mutation did not reach the server');})]);
      await expect(badge(alice,'❤️')).toHaveCount(0);await expect(row(alice).getByRole('button',{name:'React to message',exact:true})).toBeDisabled();
      check('reactions wait for confirmation and block duplicate submissions using storage IDs',count===1);
      release();for(const page of [alice,bob])await expect(badge(page,'❤️')).toBeVisible();await alice.unroute(routePath);
      await alice.route(routePath,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'SERVICE_UNAVAILABLE',fields:[]})}));
      await badge(alice,'❤️').click();await expect(alice.getByText('Could not update reactions. Your previous reaction is unchanged. Try again.',{exact:true})).toBeVisible();
      for(const page of [alice,bob])await expect(badge(page,'❤️')).toBeVisible();await alice.unroute(routePath);
      await badge(alice,'❤️').click();for(const page of [alice,bob])await expect(badge(page,'❤️')).toHaveCount(0);
      check('failed removal preserves the confirmed reaction and explicit retry succeeds',true);
      let lost=0;await bob.route(routePath,async route=>{lost++;await route.fetch();await route.abort('failed');});
      await full(bob,'fire','fire 🔥');for(const page of [alice,bob])await expect(badge(page,'🔥')).toBeVisible();await bob.unroute(routePath);
      check('lost acknowledgment reconciles through metadata without duplicate mutations',lost===1);
      const metadata=await api(alice,`/api/conversations/${cid}/reactions?ids=${original.storageId}`);
      check('reaction metadata contains no decrypted message text',!JSON.stringify(metadata.body).includes(secretTexts[0])&&!JSON.stringify(metadata.body).includes('ciphertext'));
      check('outsiders cannot read or mutate reactions',(await api(charlie,`/api/conversations/${cid}/reactions?ids=${original.storageId}`)).status===404&&
        (await api(charlie,`/api/messages/${original.storageId}/reaction`,'POST',{emoji:'👍',expectedRevision:0,operationId:randomUUID()})).status===404);
      await alice.reload();await select(alice,'Bob');await connected(alice);await expect(badge(alice,'🔥')).toBeVisible();
      await bob.getByRole('button',{name:'Sign Out',exact:true}).click();await expect(bob.getByLabel('Username or email')).toBeVisible();
      await login(bob,origin,usernames[1],password);await select(bob,'Alice');await connected(bob);await expect(badge(bob,'🔥')).toBeVisible();
      check('reactions survive reload and sign-out/sign-in on the enrolled device',true);
      await a.setOffline(true);await full(bob,'vietnam','flag: Vietnam 🇻🇳');await expect(badge(bob,'🇻🇳')).toBeVisible();
      await a.setOffline(false);await connected(alice);await expect(badge(alice,'🇻🇳')).toBeVisible();await expect(badge(alice,'🔥')).toHaveCount(0);
      check('offline recovery replaces stale reactions without manual refresh',true);
      check('reaction operations preserve the exact encrypted message record',JSON.stringify((await history()).find(m=>m.id===original.id))===JSON.stringify(original));
      await quick(alice,'👍');await expect(badge(alice,'👍')).toBeVisible();
      await row(alice).hover();await row(alice).getByRole('button',{name:'More actions',exact:true}).click();await alice.getByRole('menuitem',{name:'Delete',exact:true}).click();
      await alice.getByRole('dialog').getByRole('button',{name:'Delete',exact:true}).click();
      for(const page of [alice,bob]){await expect(row(page).getByText('Message deleted',{exact:true})).toBeVisible();await expect(row(page).locator('.rx-pill')).toHaveCount(0);}
      const removed=await api(alice,`/api/conversations/${cid}/reactions?ids=${original.storageId}`);
      check('Unsend clears all reaction metadata while preserving the message tombstone',removed.body.items[0].state==='deleted'&&removed.body.items[0].actors.length===0);
      check('reaction hints contain only identifiers for authorized participants',evidence.reactionHints?.length>=2&&evidence.reactionHints.every(h=>h.page!==2&&h.conversationId===cid&&JSON.stringify(h.keys)===JSON.stringify(['conversationId','messageId'])));
      check('reaction flow preserves V2 E2EE without plaintext leaks or browser exceptions',evidence.plaintextLeaks===0&&evidence.runtimeErrors===0&&evidence.socketSends===evidence.v2Sends);
      evidence.passed=true;evidence.nextStartupHealthy=next.exitCode===null;evidence.backendHealthy=backend.exitCode===null;return;
    }
    if (process.argv.includes('--pins-only')) {
      const cid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
      const history = async () => (await api(alice, `/api/conversations/${cid}/messages?limit=50`)).body.items;
      const original = (await history()).find(message => message.senderId === accounts[0].id);
      const row = (page, id) => page.getByRole('log').locator(`[data-message-id="${id}"]`);
      const pinned = page => page.getByRole('button', { name: 'View pinned messages', exact: true });
      const menu = async (page, id, action) => {
        await row(page, id).hover(); await row(page, id).getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: action, exact: true }).click();
      };
      const pinPath = '**/api/messages/' + original.storageId + '/pin'; let release, seen;
      const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { seen = resolve; }); let postCount = 0;
      await alice.route(pinPath, async route => { postCount++; seen(); await gate; await route.continue(); });
      await menu(alice, original.id, 'Pin');
      await Promise.race([started, delay(15000).then(() => { throw new Error('Pin mutation did not reach the authorized endpoint'); })]);
      await expect(pinned(alice)).toHaveCount(0); await expect(pinned(bob)).toHaveCount(0);
      await row(alice, original.id).hover(); await row(alice, original.id).getByRole('button', { name: 'More actions', exact: true }).click();
      await expect(alice.getByRole('menuitem', { name: 'Pin', exact: true })).toBeDisabled(); await alice.keyboard.press('Escape');
      check('Pin waits for server confirmation and prevents repeated submissions using the storage ID', postCount === 1);
      release(); await expect(pinned(alice)).toBeVisible(); await expect(pinned(bob)).toBeVisible({ timeout: 30000 }); await alice.unroute(pinPath);
      for (const page of [alice, bob]) {
        await pinned(page).click(); await page.getByRole('region', { name: 'Pinned messages' }).locator('.pinned-message-link').click();
        await expect(row(page, original.id)).toHaveAttribute('data-message-highlighted', 'true');
      }
      check('both participants share the existing pinned list and navigate to the original wire-ID row', true);
      check('outsiders cannot read or modify pin metadata', (await api(charlie, `/api/conversations/${cid}/pins`)).status === 404 &&
        (await api(charlie, `/api/messages/${original.storageId}/pin`, 'POST', { pinned: false, expectedVersion: 1, operationId: randomUUID() })).status === 404);
      await alice.reload(); await bob.reload(); await select(alice, 'Bob'); await select(bob, 'Alice'); await connected(alice); await connected(bob);
      await expect(pinned(alice)).toBeVisible(); await expect(pinned(bob)).toBeVisible(); check('shared pins survive both history reloads', true);
      await menu(bob, original.id, 'Unpin'); await expect(pinned(alice)).toHaveCount(0); await expect(pinned(bob)).toHaveCount(0);
      check('the recipient can unpin a sender message for both participants', true);
      await menu(bob, original.id, 'Pin'); await expect(pinned(alice)).toBeVisible(); await expect(pinned(bob)).toBeVisible();
      const local = await localDeleteReview(alice, secretTexts[0]); await local.review.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row(alice, original.id)).toHaveCount(0); await expect(pinned(alice)).toHaveCount(0); await expect(pinned(bob)).toBeVisible();
      check('Delete for Me hides a pin only on this device without removing shared server metadata', (await api(bob, `/api/conversations/${cid}/pins`)).body.items.length === 1);
      check('Unsend of a locally hidden pinned message still uses the original sender-authorized API', (await api(alice, `/api/messages/${original.storageId}`, 'DELETE')).status === 200);
      await expect(row(bob, original.id).getByText('Message deleted', { exact: true })).toBeVisible(); await expect(pinned(bob)).toHaveCount(0);
      check('Unsend removes the shared pin atomically without revealing a locally hidden original', (await api(bob, `/api/conversations/${cid}/pins`)).body.items.length === 0 && await row(alice, original.id).count() === 0);
      await send(alice, secretTexts[24]); await expect(bob.getByRole('log').getByText(secretTexts[24], { exact: true })).toBeVisible();
      const offline = (await history())[0]; await b.setOffline(true); await menu(alice, offline.id, 'Pin'); await expect(pinned(alice)).toBeVisible();
      await b.setOffline(false); await connected(bob); await expect(pinned(bob)).toBeVisible(); check('offline recipient recovers pins without manual refresh', true);
      const offlinePath = '**/api/messages/' + offline.storageId + '/pin';
      await alice.route(offlinePath, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', fields: [] }) }));
      await menu(alice, offline.id, 'Unpin'); await expect(alice.getByText('Could not update pinned messages. Refresh and try again.', { exact: true })).toBeVisible();
      await expect(pinned(alice)).toBeVisible(); await expect(pinned(bob)).toBeVisible(); await alice.unroute(offlinePath);
      await menu(alice, offline.id, 'Unpin'); await expect(pinned(alice)).toHaveCount(0); await expect(pinned(bob)).toHaveCount(0);
      check('failed Unpin preserves the shared pin and an explicit retry succeeds', true);
      let lostCount = 0; await alice.route(offlinePath, async route => { lostCount++; await route.fetch(); await route.abort('failed'); });
      await menu(alice, offline.id, 'Pin'); await expect(pinned(alice)).toBeVisible(); await expect(pinned(bob)).toBeVisible(); await alice.unroute(offlinePath);
      check('lost pin acknowledgment is reconciled without a duplicate mutation', lostCount === 1);
      await bob.getByRole('button', { name: 'Sign Out', exact: true }).click(); await expect(bob.getByLabel('Username or email')).toBeVisible();
      await login(bob, origin, usernames[1], password); await select(bob, 'Alice'); await connected(bob); await expect(pinned(bob)).toBeVisible();
      check('server pins persist across logout and sign-in on the same enrolled browser', true);
      await stopOwned(backend); backend = start(['src/data/main.ts'], path.join(root, '../server'), backendEnv); await healthy(`http://127.0.0.1:${backendPort}/healthz`);
      await connected(alice); await connected(bob); await expect(pinned(alice)).toBeVisible(); await expect(pinned(bob)).toBeVisible();
      check('pins survive an isolated backend restart and authenticated reconnect', (await api(bob, `/api/conversations/${cid}/pins`)).body.items.length === 1);
      check('pinning and unpinning preserve encrypted message identity and bytes', JSON.stringify((await history()).find(message => message.id === offline.id)) === JSON.stringify(offline));
      check('pin hints contain only a conversation ID and reach authorized participants', evidence.pinHints?.length >= 2 && evidence.pinHints.every(hint => hint.page !== 2 && hint.conversationId === cid && JSON.stringify(hint.keys) === JSON.stringify(['conversationId'])));
      check('shared pin flow keeps V2 encryption without plaintext network leaks or browser exceptions', evidence.plaintextLeaks === 0 && evidence.runtimeErrors === 0 && evidence.socketSends === evidence.v2Sends);
      evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null; return;
    }
    if (process.argv.includes('--a2-only')) {
      const cid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
      const historyPath = `/api/conversations/${cid}/messages?limit=50`, pinsPath = `/api/conversations/${cid}/pins`;
      for (const operation of ['edit', 'unsend']) {
        const text = `A2 original ${operation} ${suffix}`, edited = `A2 edited ${operation}\n${suffix}`;
        secretTexts.push(text, edited);
        const previous = new Set((await api(alice, historyPath)).body.items.map(m => m.id));
        await send(alice, text);
        const original = (await api(alice, historyPath)).body.items.find(m => !previous.has(m.id));
        const collection = (await api(alice, pinsPath)).body;
        check(`A2 ${operation}: pin the test message through authorized DATA`,
          (await api(alice, '/api/messages/' + original.storageId + '/pin', 'POST', { pinned: true, expectedVersion: collection.version, operationId: randomUUID() })).status === 200);
        await expect(bob.getByRole('button', { name: 'View pinned messages', exact: true })).toBeVisible();
        await bob.getByRole('button', { name: 'View pinned messages', exact: true }).click();
        const pinRegion = bob.getByRole('region', { name: 'Pinned messages' });
        await expect(pinRegion.getByText(text, { exact: true })).toBeVisible();
        const oldPins = (await api(bob, pinsPath)).body;
        const observer = await b.newPage(); monitor(observer);
        await observer.goto(origin); await select(observer, 'Alice');
        const originalRow = page => page.getByRole('log').locator(`[data-message-id="${original.id}"]`);
        await expect(originalRow(observer).getByText(text, { exact: true })).toBeVisible();
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const historyReplay = '**/api/conversations/' + cid + '/messages?*';
        const pinReplay = '**' + pinsPath;
        await bob.route(historyReplay, async route => {
          const response = await route.fetch(), body = await response.json();
          body.items = body.items.map(m => m.id === original.id ? original : m);
          await route.fulfill({ response, json: body });
        });
        await bob.route(pinReplay, async route => {
          await held; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(oldPins) });
        });
        try {
          if (operation === 'edit') {
            await originalRow(alice).hover(); await originalRow(alice).getByRole('button', { name: 'More actions', exact: true }).click();
            await alice.getByRole('menuitem', { name: 'Edit', exact: true }).click();
            await alice.getByRole('textbox', { name: 'Edit message', exact: true }).fill(edited);
            await alice.getByRole('button', { name: 'Save edit', exact: true }).click();
            await expect(originalRow(observer).getByText(edited, { exact: true })).toBeVisible();
          } else {
            check('A2 unsend: sender-authorized deletion succeeds', (await api(alice, '/api/messages/' + original.storageId, 'DELETE')).status === 200);
            await expect(originalRow(observer).getByText('Message deleted', { exact: true })).toBeVisible();
          }
          check(`A2 ${operation}: another tab verifies the new state using the same browser key store`, true);
          await expect(pinRegion.getByText(text, { exact: true })).toBeVisible();
          release();
          await expect(pinRegion.getByText(text, { exact: true })).toHaveCount(0);
          check(`A2 ${operation}: normal pin refresh rejects a cached replay after the other tab's watermark`, true);
          await refresh(bob);
          await expect(pinRegion.getByText(text, { exact: true })).toHaveCount(0);
          check(`A2 ${operation}: forced refresh also refuses the original plaintext`, true);
        } finally {
          release(); await bob.unroute(historyReplay); await bob.unroute(pinReplay); await observer.close();
        }
        await refresh(bob);
        if (operation === 'edit') {
          await expect(pinRegion.getByText(edited, { exact: true })).toBeVisible();
          const latest = (await api(alice, pinsPath)).body;
          check('A2 valid edited pin recovers without changing pin-version identity', latest.version === oldPins.version && latest.items[0].message.id === original.id);
          check('A2 valid edited pin can still be unpinned', (await api(alice, '/api/messages/' + original.storageId + '/pin', 'POST',
            { pinned: false, expectedVersion: latest.version, operationId: randomUUID() })).status === 200);
        }
        await expect(bob.getByRole('button', { name: 'View pinned messages', exact: true })).toHaveCount(0);
      }
      check('A2 cross-tab checks preserve ciphertext-only sends and have no browser runtime exceptions', evidence.plaintextLeaks === 0 && evidence.runtimeErrors === 0);
      evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null; return;
    }
    if (process.argv.includes('--edit-only')||process.argv.includes('--edit-unavailable-only')) {
      const cid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
      const history = async page => (await api(page, `/api/conversations/${cid}/messages?limit=50`)).body.items;
      const before = await history(alice), original = before.find(message => message.senderId === accounts[0].id);
      const row = page => page.getByRole('log').locator(`[data-message-id="${original.id}"]`);
      await row(bob).hover(); await row(bob).getByRole('button', { name: 'More actions', exact: true }).click();
      await expect(bob.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0); await bob.keyboard.press('Escape');
      check('received messages never expose Edit', true);
      const envelope = Object.fromEntries(['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption'].map(key => [key, original[key]]));
      const route = '/api/messages/' + original.storageId;
      const own = await api(alice, route, 'PATCH', { expectedRevision: original.revision, envelope });
      check('legacy ciphertext overwrite bodies remain rejected', own.status === 400 && own.body.code === 'VALIDATION_ERROR');
      check('recipient and unrelated account cannot bypass Edit authorization',
        (await api(bob, route, 'PATCH', {})).status === 403 && (await api(charlie, route, 'PATCH', {})).status === 404);
      const captures=[];alice.on('request',r=>{if(r.method()==='PATCH'&&new URL(r.url()).pathname===route)captures.push(JSON.parse(r.postData()));});
      evidence.editResponses=[];alice.on('response',async r=>{if(r.request().method()==='PATCH'&&new URL(r.url()).pathname===route){const body=await r.json().catch(()=>({}));evidence.editResponses.push({status:r.status(),code:body.code,outcome:body.outcome,revision:body.edit?.revision});}});
      const texts=['Edited 👩🏽‍💻\nTiếng Việt 🇻🇳 '+suffix,'Offline edited\n🍕 '+suffix,'Retry edited\n🍀 '+suffix,'Lost response edit\n🎯 '+suffix];secretTexts.push(...texts);
      const openEdit=async()=>{await row(alice).hover();await row(alice).getByRole('button',{name:'More actions',exact:true}).click();await alice.getByRole('menuitem',{name:'Edit',exact:true}).click();return alice.getByRole('textbox',{name:'Edit message',exact:true});};
      let editor=await openEdit();await expect(editor).toHaveValue(secretTexts[0]);await editor.fill('Cancelled edit');await alice.getByRole('button',{name:'Cancel edit',exact:true}).click();
      check('Cancel preserves multiline content and sends no revision',captures.length===0&&JSON.stringify(await history(alice))===JSON.stringify(before));
      editor=await openEdit();await editor.fill(texts[0]);await editor.press('Control+Enter');
      await expect(alice.getByRole('textbox',{name:'Edit message'})).toHaveCount(0);
      for(const page of [alice,bob]){await expect(row(page).getByText(texts[0],{exact:true})).toBeVisible();await expect(row(page).getByText('(edited)',{exact:true})).toBeVisible();}
      check('sender and recipient decrypt a multiline Unicode edit over authenticated realtime without Refresh',true);
      let latest=(await history(alice)).find(m=>m.id===original.id);const {edit,...base}=latest;
      check('editing preserves original ciphertext, wire/storage IDs, ownership, timestamp and sequence',JSON.stringify(base)===JSON.stringify(original)&&edit.proofs.length===1);
      check('PATCH carries signed versioned metadata and independent V2 ciphertext, never the edited plaintext',captures[0].proof.v===1&&captures[0].envelope.encryption.version===2&&captures[0].envelope.id!==original.id&&captures[0].envelope.encryption.iv!==original.encryption.iv&&!JSON.stringify(captures[0]).includes(texts[0]));
      check('edited messages remain pinnable and reactable',
        (await api(alice,route+'/pin','POST',{pinned:true,expectedVersion:0,operationId:randomUUID()})).status===200&&
        (await api(bob,route+'/reaction','POST',{emoji:'👍',expectedRevision:0,operationId:randomUUID()})).status===200);
      await expect(row(alice).getByRole('button',{name:'👍 1',exact:true})).toBeVisible();
      await bob.getByRole('button',{name:'View pinned messages',exact:true}).click();
      await expect(bob.getByRole('region',{name:'Pinned messages'}).getByText(texts[0],{exact:true})).toBeVisible();
      await bob.getByRole('region',{name:'Pinned messages'}).locator('.pinned-message-link').click();await expect(row(bob)).toHaveAttribute('data-message-highlighted','true');
      check('the shared pinned list verifies the latest edited text and preserves navigation identity',true);
      const replyText='Reply to edited original '+suffix;secretTexts.push(replyText);
      await row(bob).hover();await row(bob).getByRole('button',{name:'Reply',exact:true}).click();await send(bob,replyText);
      const replyRow=page=>page.getByRole('log').locator('article').filter({has:page.getByText(replyText,{exact:true})});
      await expect(replyRow(alice).locator('.message-reply-quote')).toContainText(texts[0]);
      await replyRow(bob).locator('.message-reply-quote').click();await expect(row(bob)).toHaveAttribute('data-message-highlighted','true');
      check('replies to edited messages quote verified current content and navigate to the same original',true);
      await row(alice).hover();await row(alice).getByRole('button',{name:'More actions',exact:true}).click();await alice.getByRole('menuitem',{name:'Forward',exact:true}).click();
      const forwardDialog=alice.getByRole('dialog',{name:'Forward to'});await forwardDialog.getByRole('button',{name:'Bob',exact:true}).click();await forwardDialog.getByRole('button',{name:'Send',exact:true}).click();await expect(forwardDialog).toBeHidden();
      const forwarded=(await history(alice)).find(m=>m.senderId===accounts[0].id&&m.id!==original.id);
      await expect(bob.getByRole('log').locator(`[data-message-id="${forwarded.id}"]`).getByText('Forwarded',{exact:true})).toBeVisible();
      check('forwarding an edited message creates an independently encrypted copy',forwarded.encryption.ciphertext!==original.encryption.ciphertext&&forwarded.id!==original.id);
      check('edit retries are idempotent through the real proxy',(await api(alice,route,'PATCH',captures[0])).body.outcome==='duplicate');
      check('forged and out-of-order revisions are refused',(await api(alice,route,'PATCH',{...captures[0],proof:{...captures[0].proof,revision:9}})).status===400);
      check('Edit enforces CSRF',await alice.evaluate(async({route,body})=>(await fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,{route,body:captures[0]})===403);
      await b.setOffline(true);editor=await openEdit();await editor.fill(texts[1]);const offlineEditStarted=Date.now();await alice.getByRole('button',{name:'Save edit',exact:true}).click();await expect(alice.getByRole('textbox',{name:'Edit message'})).toHaveCount(0,{timeout:30000});evidence.offlineEditConfirmationMs=Date.now()-offlineEditStarted;
      await b.setOffline(false);await connected(bob);await expect(row(bob).getByText(texts[1],{exact:true})).toBeVisible();check('offline recovery restores the latest signed revision',true);
      await expect(replyRow(bob).locator('.message-reply-quote')).toContainText(texts[1]);
      await bob.getByRole('button',{name:'View pinned messages',exact:true}).click();await expect(bob.getByRole('region',{name:'Pinned messages'}).getByText(texts[1],{exact:true})).toBeVisible();await bob.getByRole('region',{name:'Pinned messages'}).locator('.pinned-message-link').click();
      await expect(row(bob).getByRole('button',{name:'👍 1',exact:true})).toBeVisible();check('offline edits refresh reply previews and pinned text without resetting reaction counts',true);
      const failRoute='**'+route;
      await alice.route(failRoute,r=>r.request().method()==='PATCH'?r.fulfill({status:503,contentType:'application/json',body:'{"code":"SERVICE_UNAVAILABLE"}'}):r.continue());
      editor=await openEdit();await editor.fill(texts[2]);await alice.getByRole('button',{name:'Save edit',exact:true}).click();await expect(alice.getByRole('alert').filter({hasText:'Your edit could not be confirmed'})).toBeVisible();
      await expect(editor).toHaveValue(texts[2]);await expect(row(bob).getByText(texts[1],{exact:true})).toBeVisible();
      const failed=captures.at(-1);check('failed requests preserve the editor draft and recipients original content',true);
      await alice.unroute(failRoute);await alice.getByRole('button',{name:'Save edit',exact:true}).click();await expect(editor).toHaveCount(0);await expect(row(bob).getByText(texts[2],{exact:true})).toBeVisible();
      check('retry reuses identical ciphertext, signature, nonce and operation ID',JSON.stringify(failed)===JSON.stringify(captures.at(-1)));
      await alice.route(failRoute,async r=>{if(r.request().method()!=='PATCH')return r.continue();const response=await r.fetch();await r.fulfill({response,status:503,contentType:'application/json',body:'{"code":"SERVICE_UNAVAILABLE"}'});});
      editor=await openEdit();await editor.fill(texts[3]);await alice.getByRole('button',{name:'Save edit',exact:true}).click();await expect(alice.getByRole('alert').filter({hasText:'Your edit could not be confirmed'})).toBeVisible();await expect(row(bob).getByText(texts[3],{exact:true})).toBeVisible();
      const sent=captures.length;await alice.unroute(failRoute);await alice.getByRole('button',{name:'Save edit',exact:true}).click();await expect(editor).toHaveCount(0);
      latest=(await history(alice)).find(m=>m.id===original.id);check('lost-response recovery confirms history without a duplicate PATCH or revision',captures.length===sent&&latest.edit.proofs.length===4);
      await alice.reload();await bob.reload();await select(alice,'Bob');await select(bob,'Alice');await connected(alice);await connected(bob);
      for(const page of [alice,bob])await expect(row(page).getByText(texts[3],{exact:true})).toBeVisible();check('refresh preserves signed edit history and the Edited indicator',true);
      await bob.route('**/api/conversations/'+cid+'/messages?*',async r=>{const response=await r.fetch(),body=await response.json();for(const item of body.items)if(item.id===original.id)delete item.edit;await r.fulfill({response,json:body});});
      await bob.reload();await select(bob,'Alice');await expect(row(bob).getByText(secretTexts[0],{exact:true})).toHaveCount(0);await expect(row(bob).getByText(texts[3],{exact:true})).toBeVisible();
      check('a fresh verified pin snapshot safely supplies the latest edit while stale history is rejected',true);
      const stalePins='**/api/conversations/'+cid+'/pins';
      await bob.route(stalePins,async r=>{const response=await r.fetch(),body=await response.json();for(const item of body.items)if(item.message.id===original.id)delete item.message.edit;await r.fulfill({response,json:body});});
      await bob.reload();await select(bob,'Alice');await expect(row(bob).getByText(secretTexts[0],{exact:true})).toHaveCount(0);await expect(row(bob).getByText(texts[3],{exact:true})).toHaveCount(0);
      check('persisted device watermark rejects replayed originals from history and pins after browser reload',true);await bob.unroute('**/api/conversations/'+cid+'/messages?*');await bob.unroute(stalePins);await bob.reload();await select(bob,'Alice');await expect(row(bob).getByText(texts[3],{exact:true})).toBeVisible();
      await bob.getByRole('button',{name:'Sign Out',exact:true}).click();await login(bob,origin,usernames[1],password);await select(bob,'Alice');await expect(row(bob).getByText(texts[3],{exact:true})).toBeVisible();check('logout/login preserves device keys and latest revision validation',true);
      const removed=await api(alice,route,'DELETE');check('Unsend remains sender-authorized after edits',removed.status===200&&removed.body.message.edit===undefined);
      await expect(row(bob).getByText('Message deleted',{exact:true})).toBeVisible();check('Unsend prevents revision replay',(await api(alice,route,'PATCH',captures.at(-1))).status===404);
      await expect(replyRow(bob).locator('.message-reply-quote')).toContainText('Original message deleted');await expect(bob.getByRole('button',{name:'View pinned messages',exact:true})).toHaveCount(0);
      check('Unsend cleans edited-message pins and leaves replies in a safe unavailable-original state',true);
      await bob.reload();await select(bob,'Alice');await expect(row(bob).getByText('Message deleted',{exact:true})).toBeVisible();check('terminal Unsend cannot restore edited content after reload',true);
      check('encrypted editing preserves V2 encryption without plaintext network leaks or browser exceptions', evidence.plaintextLeaks === 0 && evidence.runtimeErrors === 0 && evidence.invalidAuthShapes === 0 && evidence.socketSends === evidence.v2Sends);
      evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null; return;
    }
    if (process.argv.includes('--unsend-only')) {
      const cid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
      const history = async () => (await api(alice, `/api/conversations/${cid}/messages?limit=50`)).body.items;
      const original = (await history()).find(message => message.senderId === accounts[0].id);
      const row = (page, id) => page.getByRole('log').locator(`[data-message-id="${id}"]`);
      const review = async (page, id) => {
        await row(page, id).hover(); await row(page, id).getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('radio', { name: /Delete for everyone/ })).toBeChecked();
        await expect(dialog.getByRole('radio', { name: /Delete for you/ })).toBeEnabled(); return dialog;
      };
      const removed = async id => {
        for (const page of [alice, bob]) await expect(row(page, id).getByText('Message deleted', { exact: true })).toBeVisible({ timeout: 45000 });
      };
      check('wire ID is distinct from the storage ID used by the existing Unsend API', original.id !== original.storageId);
      await row(bob, original.id).hover(); await row(bob, original.id).getByRole('button', { name: 'More actions', exact: true }).click();
      await bob.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      const recipientDelete = bob.getByRole('dialog');
      await expect(recipientDelete.getByRole('radio', { name: /Delete for you/ })).toBeChecked();
      await expect(recipientDelete.getByRole('radio', { name: /Delete for everyone/ })).toHaveCount(0);
      await bob.keyboard.press('Escape'); await expect(recipientDelete).toBeHidden();
      check('recipient Delete offers only local removal and Escape cancels it', true);
      check('recipient and unrelated account cannot unsend the sender message',
        (await api(bob, '/api/messages/' + original.storageId, 'DELETE')).status === 403 &&
        (await api(charlie, '/api/messages/' + original.storageId, 'DELETE')).status === 404);
      await row(bob, original.id).hover(); await row(bob, original.id).getByRole('button', { name: 'Reply', exact: true }).click();
      await send(bob, secretTexts[20]); await expect(alice.getByRole('log').getByText(secretTexts[20], { exact: true })).toBeVisible();
      const reply = (await history())[0];
      await row(bob, original.id).hover(); await row(bob, original.id).getByRole('button', { name: 'More actions', exact: true }).click();
      await bob.getByRole('menuitem', { name: 'Forward', exact: true }).click();
      let dialog = bob.getByRole('dialog'); await dialog.getByRole('button', { name: 'Alice', exact: true }).click();
      await dialog.getByRole('button', { name: 'Send', exact: true }).click(); await expect(dialog).toBeHidden();
      await expect(bob.getByRole('log').getByText('Forwarded', { exact: true })).toBeVisible();
      const copy = (await history())[0];
      const deletePath = '**/api/messages/' + original.storageId;
      let release, requestSeen; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { requestSeen = resolve; }); let deletes = 0;
      await alice.route(deletePath, async route => { deletes++; requestSeen(); await gate; await route.continue(); });
      dialog = await review(alice, original.id); await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await started;
      await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toHaveAttribute('aria-busy', 'true'); await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
      for (const page of [alice, bob]) await expect(row(page, original.id).getByText(secretTexts[0], { exact: true })).toBeVisible();
      check('Unsend retains the original while waiting for server confirmation and prevents duplicate submissions', deletes === 1);
      release(); await expect(dialog).toBeHidden(); await removed(original.id); await alice.unroute(deletePath);
      const tombstone = (await history()).find(message => message.id === original.id);
      check('server confirmation preserves wire/storage identity and sequence while replacing ciphertext with a tombstone',
        tombstone.storageId === original.storageId && tombstone.sequence === original.sequence && tombstone.revision === original.revision + 1 && tombstone.encryption === null && tombstone.state === 'deleted');
      for (const page of [alice, bob]) {
        await expect(row(page, reply.id).getByText('Original message deleted.', { exact: true })).toBeVisible();
        await row(page, reply.id).getByRole('button', { name: /^Go to original message/ }).click();
        await expect(page.getByText('The original message was deleted.', { exact: true })).toBeVisible();
        await expect(row(page, copy.id).getByText(secretTexts[0], { exact: true })).toBeVisible();
      }
      const retained = await history();
      check('Unsend preserves encrypted reply metadata and independently forwarded copies',
        [reply, copy].every(before => JSON.stringify(retained.find(message => message.id === before.id).encryption) === JSON.stringify(before.encryption)));
      await alice.reload(); await bob.reload(); await select(alice, 'Bob'); await select(bob, 'Alice'); await connected(alice); await connected(bob); await removed(original.id);
      check('both authenticated sessions retain the tombstone after history reload', true);
      await send(alice, secretTexts[21]); await expect(bob.getByRole('log').getByText(secretTexts[21], { exact: true })).toBeVisible();
      const offline = (await history())[0]; await b.setOffline(true);
      dialog = await review(alice, offline.id); await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toBeHidden();
      await b.setOffline(false); await connected(bob); await removed(offline.id);
      check('offline recipient recovers a missed Unsend from durable history on reconnect', true);
      await send(alice, secretTexts[22]); await expect(bob.getByRole('log').getByText(secretTexts[22], { exact: true })).toBeVisible();
      const failed = (await history())[0], failurePath = '**/api/messages/' + failed.storageId;
      await alice.route(failurePath, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', fields: [] } }) }));
      dialog = await review(alice, failed.id); await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Your message is unchanged');
      for (const page of [alice, bob]) await expect(row(page, failed.id).getByText(secretTexts[22], { exact: true })).toBeVisible();
      check('failed Unsend shows useful feedback and preserves both participants original message', (await history()).find(message => message.id === failed.id).state === 'active');
      await alice.unroute(failurePath); await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toBeHidden(); await removed(failed.id);
      check('retry after a real failure commits one tombstone', (await history()).find(message => message.id === failed.id).revision === failed.revision + 1);
      await send(alice, secretTexts[23]); await expect(bob.getByRole('log').getByText(secretTexts[23], { exact: true })).toBeVisible();
      const lost = (await history())[0], lostPath = '**/api/messages/' + lost.storageId; let lostRequests = 0;
      await alice.route(lostPath, async route => { lostRequests++; await route.fetch(); await route.abort('failed'); });
      dialog = await review(alice, lost.id); await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toBeHidden(); await removed(lost.id); await alice.unroute(lostPath);
      check('lost HTTP acknowledgment is reconciled from authorized history without a duplicate DELETE', lostRequests === 1 && (await history()).find(message => message.id === lost.id).revision === lost.revision + 1);
      check('only authorized participants receive server Unsend hints containing identifiers alone', evidence.deletionHints?.length >= 2 && evidence.deletionHints.every(hint => hint.page !== 2 && hint.conversationId === cid && JSON.stringify(hint.keys) === JSON.stringify(['conversationId', 'messageId'])));
      check('Unsend preserves genuine V2 encryption without plaintext network leaks or browser exceptions', evidence.plaintextLeaks === 0 && evidence.runtimeErrors === 0 && evidence.invalidAuthShapes === 0 && evidence.socketSends === evidence.v2Sends);
      evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null; return;
    }
    if (process.argv.includes('--reply-forward-only')) {
      const cid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
      const originalRows = (await api(alice, `/api/conversations/${cid}/messages?limit=50`)).body.items;
      const originalAlice = originalRows.find(row => row.senderId === accounts[0].id), originalBob = originalRows.find(row => row.senderId === accounts[1].id);
      const row = (page, id) => page.getByRole('log').locator(`[data-message-id="${id}"]`);
      const reply = async (page, id, text) => {
        await row(page, id).hover(); await row(page, id).getByRole('button', { name: 'Reply', exact: true }).click();
        await expect(page.locator('.reply-preview-banner')).toBeVisible(); await send(page, text);
        await expect(page.locator('.reply-preview-banner')).toHaveCount(0);
      };
      await reply(alice, originalBob.id, secretTexts[15]);
      await expect(bob.getByRole('log').getByText(secretTexts[15], { exact: true })).toBeVisible({ timeout: 30000 });
      const replyId = (await api(alice, `/api/conversations/${cid}/messages?limit=1`)).body.items[0].id;
      await row(alice, replyId).getByRole('button', { name: 'Go to original message from Bob', exact: true }).click();
      await expect(row(alice, originalBob.id)).toHaveAttribute('data-message-highlighted', 'true');
      check('received-message reply is encrypted, received, and navigates to the original wire ID', true);
      await reply(bob, originalBob.id, secretTexts[16]);
      await expect(alice.getByRole('log').getByText(secretTexts[16], { exact: true })).toBeVisible({ timeout: 30000 });
      check('sent-message reply is independently encrypted and received by the other account', true);
      await alice.reload(); await select(alice, 'Bob'); await connected(alice);
      await expect(row(alice, replyId).getByRole('button', { name: 'Go to original message from Bob' })).toBeVisible();
      check('encrypted reply metadata survives history reload', true);
      await a.setOffline(true); await reply(bob, originalAlice.id, secretTexts[17]); await a.setOffline(false); await connected(alice);
      await expect(alice.getByRole('log').getByText(secretTexts[17], { exact: true })).toHaveCount(1, { timeout: 45000 });
      check('reconnect reconciles an encrypted reply without duplicates', true);
      await row(alice, originalBob.id).hover(); await row(alice, originalBob.id).getByRole('button', { name: 'More actions' }).click();
      await alice.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await alice.getByRole('dialog').getByRole('radio', { name: /Delete for you/ }).check(); await alice.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row(alice, originalBob.id)).toHaveCount(0);
      await expect(row(alice, replyId).getByText('Original message unavailable.', { exact: true })).toBeVisible();
      await row(alice, replyId).getByRole('button', { name: 'Go to original message from a message' }).click();
      await expect(alice.getByText('The original message is unavailable in the loaded history.', { exact: true })).toBeVisible();
      await expect(row(bob, originalBob.id)).toBeVisible(); check('Delete for Me hides original quotes locally without changing the other account', true);
      const friendship = await api(alice, '/api/friends/requests', 'POST', { userId: accounts[2].id });
      await api(charlie, '/api/friends/requests/' + friendship.body.request.id + '/accept', 'POST');
      const destination = (await api(alice, '/api/conversations/dm', 'POST', { recipientId: accounts[2].id })).body.conversation;
      await alice.getByRole('button', { name: 'Refresh conversations', exact: true }).click();
      const openForward = async id => {
        await row(alice, id).hover(); await row(alice, id).getByRole('button', { name: 'More actions' }).click();
        await alice.getByRole('menuitem', { name: 'Forward', exact: true }).click();
        const dialog = alice.getByRole('dialog'); await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Charlie', exact: true }).click(); return dialog;
      };
      let dialog = await openForward(originalAlice.id); await dialog.getByLabel('Optional message', { exact: true }).fill(secretTexts[19]); await dialog.getByRole('button', { name: 'Send', exact: true }).click(); await expect(dialog).toBeHidden();
      await select(charlie, 'Alice'); await expect(charlie.getByRole('log').getByText(secretTexts[0], { exact: true })).toBeVisible({ timeout: 30000 });
      await expect(charlie.getByRole('log').getByText('Forwarded', { exact: true })).toBeVisible();
      await expect(charlie.getByRole('log').getByText(secretTexts[19], { exact: true })).toBeVisible();
      check('shared ForwardDialog delivers a separately encrypted text message to another valid conversation', true);
      await advanced(alice); await alice.getByLabel('Message transport', { exact: true }).selectOption('rest'); await alice.getByText('Advanced settings', { exact: true }).click();
      let postCount = 0;
      await alice.route('**/api/conversations/' + destination.id + '/messages', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        postCount++;
        if (postCount === 2) { await route.fetch(); await route.abort('failed'); } else await route.continue();
      });
      dialog = await openForward(replyId); await dialog.getByLabel('Optional message', { exact: true }).fill(secretTexts[18]);
      await dialog.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('optional note was not confirmed', { timeout: 30000 });
      const rowsBeforeRetry = (await api(charlie, `/api/conversations/${destination.id}/messages?limit=50`)).body.items;
      await dialog.getByRole('button', { name: 'Send', exact: true }).click(); await expect(dialog).toBeHidden();
      // REST fallback persistence uses the existing explicit history refresh contract.
      await refresh(charlie);
      await expect(charlie.getByRole('log').getByText(secretTexts[15], { exact: true })).toHaveCount(1, { timeout: 30000 });
      await expect(charlie.getByRole('log').getByText(secretTexts[18], { exact: true })).toHaveCount(1);
      const rowsAfterRetry = (await api(charlie, `/api/conversations/${destination.id}/messages?limit=50`)).body.items;
      check('lost optional-note acknowledgment reports partial failure and retry creates no duplicate forwards or notes', postCount === 2 && JSON.stringify(rowsBeforeRetry) === JSON.stringify(rowsAfterRetry));
      check('forwarded replies preserve text without leaking a source-conversation reply reference', await charlie.locator('.message-reply-quote').count() === 0);
      check('reply/forward V2 traffic has no plaintext leaks or browser runtime errors', evidence.plaintextLeaks === 0 && evidence.runtimeErrors === 0 && evidence.invalidAuthShapes === 0 && evidence.socketSends === evidence.v2Sends);
      evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null; return;
    }
    const localDeleteOnly = process.argv.includes('--local-delete-only');
    if (localDeleteOnly || process.argv.includes('--local-delete-and-key-review')) {
      await send(alice, secretTexts[12]); await expect(bob.getByRole('log').getByText(secretTexts[12], { exact: true })).toBeVisible();
      await send(bob, secretTexts[13]); await expect(alice.getByRole('log').getByText(secretTexts[13], { exact: true })).toBeVisible();
      const deleteCid = (await api(alice, '/api/conversations?limit=50')).body.items[0].id;
      const serverHistoryBefore = JSON.stringify((await api(alice, `/api/conversations/${deleteCid}/messages?limit=50`)).body.items);
      const localDeleteNetworkStart = evidence.network.length;
      let localReview = await localDeleteReview(alice, secretTexts[12]);
      await localReview.review.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(localReview.row).toBeVisible(); check('cancelling device-only deletion preserves the outgoing message', true);
      for (const text of [secretTexts[12], secretTexts[13]]) {
        localReview = await localDeleteReview(alice, text); await localReview.review.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(localReview.review).toBeHidden(); await expect(localReview.row).toHaveCount(0);
        await expect(bob.getByRole('log').getByText(text, { exact: true })).toBeVisible();
      }
      check('device-only confirmation hides sent and received messages while Bob retains both', true);
      const serverHistoryAfter = JSON.stringify((await api(alice, `/api/conversations/${deleteCid}/messages?limit=50`)).body.items);
      check('Delete for Me leaves every server message unchanged and issues no delete/edit API request', serverHistoryBefore === serverHistoryAfter &&
        !evidence.network.slice(localDeleteNetworkStart).some(request => ['DELETE', 'PATCH'].includes(request.method) && /^\/api\/(?:messages|conversations)/.test(request.path)));
      check('hidden messages cannot remain in conversation previews', await alice.locator('.conversation-list-preview').filter({ hasText: secretTexts[13] }).count() === 0);
      await alice.reload(); await expect(alice.getByText('Secure device ready', { exact: true })).toBeVisible(); await select(alice, 'Bob');
      for (const text of [secretTexts[12], secretTexts[13]]) await expect(alice.getByRole('log').getByText(text, { exact: true })).toHaveCount(0);
      check('browser refresh reloads hidden identifiers before presenting authenticated history', true);
      await alice.getByRole('button', { name: 'Sign Out', exact: true }).click(); await expect(alice.getByLabel('Username or email')).toBeVisible();
      await login(alice, origin, usernames[0], password); await select(alice, 'Bob'); await connected(alice);
      for (const text of [secretTexts[12], secretTexts[13]]) await expect(alice.getByRole('log').getByText(text, { exact: true })).toHaveCount(0);
      check('logout and same-account sign-in preserve this browser profile local hides', (await device(alice, accounts[0].id)).deviceId === before.deviceId);
      await a.setOffline(true); await send(bob, secretTexts[14]); await a.setOffline(false); await connected(alice);
      await expect(alice.getByRole('log').getByText(secretTexts[14], { exact: true })).toBeVisible({ timeout: 45000 });
      for (const text of [secretTexts[12], secretTexts[13]]) await expect(alice.getByRole('log').getByText(text, { exact: true })).toHaveCount(0);
      check('reconnect history reconciliation retains local hides while new encrypted messages arrive', true);
      if (localDeleteOnly) {
        check('local hiding preserves authenticated v2 transport with no plaintext leaks', evidence.plaintextLeaks === 0 && evidence.invalidAuthShapes === 0 && evidence.v2Sends >= 5 && evidence.socketSends === evidence.v2Sends);
        check('local deletion acceptance has no browser runtime errors', evidence.runtimeErrors === 0);
        evidence.passed = true; evidence.nextStartupHealthy = next.exitCode === null; evidence.backendHealthy = backend.exitCode === null;
        return;
      }
    }
    check('real accounts use the original sidebar, header, bubbles and composer', await alice.locator('.conversation-sidebar').count() === 1 && await alice.locator('.chat-toolbar').count() === 1 && await alice.locator('.message-bubble').count() >= 1 && await alice.locator('.composer-dock').count() === 1);
    check('real chat has no demo messages', await alice.getByText('Demo reply', { exact: true }).count() === 0);
    await expect(alice.getByRole('button', { name: 'Attach files or images', exact: true })).toBeEnabled();
    await expect(alice.getByRole('button', { name: 'Record voice message', exact: true })).toBeEnabled();
    check('integrated encrypted attachment and voice controls remain available', true);
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
    await alice.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    const mobilePicker = alice.getByRole('dialog', { name: 'Emoji picker', exact: true });
    await expect(mobilePicker).toBeVisible();
    const pickerBounds = await mobilePicker.boundingBox();
    check('real-account emoji popup fits the mobile viewport', pickerBounds && pickerBounds.x >= 0 && pickerBounds.y >= 0 && pickerBounds.x + pickerBounds.width <= 391 && pickerBounds.y + pickerBounds.height <= 845);
    await alice.getByRole('searchbox', { name: 'Search emoji' }).press('Escape'); await expect(mobilePicker).toHaveCount(0);
    await expect(alice.getByRole('textbox', { name: /^Message to / })).toBeFocused();
    check('real-account mobile picker closes with Escape and restores composer focus', true);
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
    await alice.getByRole('button', { name: 'Insert emoji', exact: true }).click();
    await expect(alice.getByRole('tab', { name: 'Recently Used', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(alice.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳', exact: true })).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Insert pizza 🍕', exact: true })).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Search emoji' }).press('Escape');
    check('real-account recent emoji survive a page reload without storing draft text', await alice.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('secubuzz:recent-emojis:v1'))) === JSON.stringify(['🇻🇳', '🍕'])));
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
    await alice.getByRole('button', { name: 'Trust these device changes', exact: true }).click(); await ready(alice);
    check('explicit contact-key review restores secure readiness', true);
    await send(alice, secretTexts[2]); await select(bob2, 'Alice');
    await expect(bob2.getByRole('log').getByText(secretTexts[2], { exact: true })).toBeVisible({ timeout: 30000 }); await expect(bob2.getByRole('log').getByText(secretTexts[0], { exact: true })).toHaveCount(0); check('new epoch includes new device without pretending old-key recovery', true);
    await connected(bob2); await send(bob2, secretTexts[6]); await expect(bob.getByRole('log').getByText(secretTexts[6], { exact: true })).toBeVisible({ timeout: 30000 }); check('another device of the sender account receives its live message', true);
    await advanced(bob2); bob2.once('dialog', d => d.accept()); await bob2.getByText('This browser and key recovery', { exact: true }).click(); await bob2.getByRole('button', { name: 'Revoke this browser', exact: true }).click(); await expect(bob2.getByText('Device revoked', { exact: true })).toBeVisible(); check('device revocation blocks new secure sends', true);
    await expect(alice.getByText('Contact device keys changed', { exact: true })).toBeVisible({ timeout: 30000 });
    await alice.setViewportSize({ width: 390, height: 844 }); check('mobile layout has no horizontal overflow', await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await alice.addStyleTag({ content: '.message-bubble, .conversation-list-preview, .composer-input { filter:blur(8px); }' }); await alice.screenshot({ path: path.join(artifacts, 'mobile-redacted.png'), fullPage: true }); evidence.screenshots.push('mobile-redacted.png');
    await alice.emulateMedia({ colorScheme: 'dark' }); await expect(alice.locator('html')).toHaveAttribute('data-theme', 'dark');
    // The theme attribute updates before the existing background transition finishes.
    await expect.poll(() => alice.locator('.conversation-security-summary').evaluate(element => {
      const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
      return element.getAnimations().every(animation => animation.playState === 'finished') &&
        channels?.length === 3 && channels.reduce((a, b) => a + b, 0) < 500;
    }), { timeout: 5000, message: 'Dark security disclosure completes its transition' }).toBe(true);
    check('dark security disclosure uses a readable dark surface', await alice.locator('.conversation-security-summary').evaluate(element => { const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number); return channels?.length === 3 && channels.reduce((a, b) => a + b, 0) < 500; }));
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
    if (e instanceof Error) {
      evidence.failureDetails = secretTexts.reduce((s, t) => s.replaceAll(t, '[redacted]').replaceAll(JSON.stringify(t).slice(1, -1), '[redacted]'), e.message).split('\n').slice(0, 18).join('\n').slice(0, 2000);
      evidence.failureLocation = e.stack?.split('\n').filter(line => /^\s+at /.test(line) && line.includes('verify-client-realtime.cjs')).slice(-3);
    }
    evidence.connections = await Promise.all(pages.map(p => p.getByRole('status', { name: 'Live connection' }).textContent({ timeout: 1000 }).catch(() => 'no workspace')));
    if(process.argv.includes('--edit-only')||process.argv.includes('--a2-only'))evidence.editAlerts=await Promise.all(pages.map(async p=>(await p.getByRole('alert').allTextContents().catch(()=>[])).map(value=>secretTexts.reduce((s,t)=>s.replaceAll(t,'[redacted]'),value).slice(0,300))));
    evidence.backendDiagnostics = children[0]?.diagnostics().split('\n').filter(line => /realtime\./.test(line)).slice(-12);
    process.exitCode = 1; console.error('Browser verification failed; sanitized evidence saved.'); }
  finally {
    await host?.close().catch(() => {});
    for (const p of children.reverse()) if (p.exitCode === null) { const exited = once(p, 'exit'); if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } else p.kill(); await Promise.race([exited, delay(5000)]); }
    evidence.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2)); console.log('Evidence: ' + path.join(artifacts, 'browser-evidence.json'));
    // Only known isolated files/processes above are owned by this script. No existing service is inspected/stopped.
  }
})();
