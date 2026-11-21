'use strict';

// Compose acceptance only. Uses owned disposable projects and synthetic accounts.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const project = process.argv[2];
assert.match(project || '', /^secubuzz-infra01c-[a-z0-9-]+$/);
assert.equal(process.env.SECUBUZZ_DOCKER_VALIDATION, 'true');
const requireClient = createRequire(path.join(root, 'client/package.json'));
const { chromium, expect } = requireClient('@playwright/test');
const { io } = requireClient('socket.io-client');
const artifactRoot = path.join(root, 'docker/artifacts');
const directory = path.resolve(process.env.SECUBUZZ_DOCKER_EVIDENCE_DIR || path.join(artifactRoot, 'infra01c'));
assert.ok(directory.toLowerCase().startsWith((artifactRoot + path.sep).toLowerCase()));
const filename = path.join(directory, 'compose-acceptance.json');
fs.mkdirSync(directory, { recursive: true });
const state = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {
  project, seed: randomUUID().slice(0, 8), checks: [], stages: {}, accounts: [], messageCount: 0,
};
assert.equal(state.project, project);
const origin = 'http://localhost:3001';
const password = 'Synthetic Docker validation ' + state.seed + ' passphrase!';
const contexts = [], pages = [];
let plaintextLeaks = 0, websocketFrames = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() { fs.writeFileSync(filename, JSON.stringify(state, null, 2) + '\n'); }
function check(name, condition = true) {
  state.checks.push({ name, passed: Boolean(condition) }); save();
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  assert.ok(condition, name);
}
async function command(args, input, allowFailure = false) {
  const started = Date.now();
  const child = spawn('docker', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 1)); });
  fs.appendFileSync(path.join(directory, 'compose-commands.log'), JSON.stringify({ args, exitCode: code, seconds: (Date.now() - started) / 1000 }) + '\n' + output + '\n');
  if (code && !allowFailure) throw new Error('Docker command failed: ' + args.slice(0, 7).join(' '));
  return { code, output };
}
function compose(name, args, allowFailure = false) {
  assert.ok(name === project || name.startsWith(project + '-restore-'));
  const extra = name === project ? [] : ['-f', 'compose.yaml', '-f', path.join(directory, 'restore-images.json')];
  return command(['compose', '-p', name, ...extra, ...args], undefined, allowFailure);
}
async function inspect(name) { return JSON.parse((await command(['inspect', name])).output)[0]; }
async function snapshot(name) {
  const result = await command(['compose', '-p', name, 'exec', '-T', '-e', 'SECUBUZZ_DOCKER_VALIDATION=true', 'backend', 'node', '--input-type=commonjs'], fs.readFileSync(path.join(__dirname, 'database-check.cjs')));
  return JSON.parse(result.output);
}
async function stage(name, action) {
  if (state.stages[name]?.passed) return;
  const started = Date.now();
  await action();
  state.stages[name] = { passed: true, seconds: Number(((Date.now() - started) / 1000).toFixed(2)) }; save();
}
async function api(page, route, method = 'GET', body) {
  return page.evaluate(async ({ route, method, body }) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      const proof = await (await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })).json();
      headers['X-CSRF-Token'] = proof.csrfToken;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(route, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { route, method, body });
}
async function login(page, account) {
  await page.goto(origin + '/login');
  await page.getByLabel('Username or email').fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your conversations', exact: true })).toBeVisible({ timeout: 60000 });
}
async function enroll(page) {
  const button = page.getByRole('button', { name: /^Enroll this browser/ });
  await expect(button).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await button.click();
  await expect(page.getByText('Secure device ready', { exact: true })).toBeVisible({ timeout: 30000 });
}
async function device(page, actor) {
  return page.evaluate(async actor => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('secubuzz-e2ee-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    try {
      const value = await new Promise((resolve, reject) => { const request = db.transaction('records', 'readonly').objectStore('records').get(JSON.stringify([actor, 'device', ''])); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      return value ? { id: value.deviceId, nonExtractable: !value.signing.privateKey.extractable && !value.agreement.privateKey.extractable } : null;
    } finally { db.close(); }
  }, actor);
}
async function connected(page) { await expect(page.getByRole('status', { name: 'Live connection' })).toContainText('Connected', { timeout: 60000 }); }
async function select(page, peer) {
  await page.getByRole('button', { name: 'Refresh conversations', exact: true }).click();
  await page.getByRole('navigation', { name: 'Direct conversations' }).getByRole('button', { name: new RegExp('^' + peer + ',') }).click();
  await expect(page.getByText('Secure message ready', { exact: true })).toBeVisible({ timeout: 45000 });
  await connected(page);
}
const message = number => 'Synthetic Docker message ' + state.seed + ' ' + number;
async function send(from, to) {
  const text = message(state.messageCount + 1);
  await from.getByRole('textbox', { name: /^Message to / }).fill(text);
  await from.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(to.getByRole('log').getByText(text, { exact: true })).toHaveCount(1, { timeout: 30000 });
  await expect(from.locator('.message-composer')).toHaveAttribute('aria-busy', 'false');
  state.messageCount++; save();
}
async function recover() {
  for (const [index, page] of pages.entries()) {
    await page.goto(origin);
    await expect(page.getByText('Secure device ready', { exact: true })).toBeVisible({ timeout: 45000 });
    await select(page, index === 0 ? 'Bob' : 'Alice');
    const current = await device(page, state.accounts[index].id);
    assert.equal(current.id, state.accounts[index].deviceId);
    await expect(page.getByRole('log').getByText(message(1), { exact: true })).toHaveCount(1);
  }
}
async function namespace(name) {
  const backend = await inspect(name + '-backend-1'), frontend = await inspect(name + '-frontend-1');
  assert.equal(frontend.HostConfig.NetworkMode, 'container:' + backend.Id);
  assert.deepEqual(backend.HostConfig.PortBindings, { '3001/tcp': [{ HostIp: '127.0.0.1', HostPort: '3001' }] });
  assert.ok(!frontend.Mounts.some(mount => mount.Destination.startsWith('/var/lib/secubuzz')));
}
async function transport(page, context, name) {
  const proof = await api(page, '/api/auth/csrf'); assert.equal(proof.status, 200);
  const cookie = (await context.cookies(origin)).map(value => value.name + '=' + value.value).join('; ');
  await new Promise((resolve, reject) => {
    const socket = io(origin, { path: '/socket.io', addTrailingSlash: false, transports: [name], reconnection: false,
      timeout: 10000, auth: { csrfToken: proof.body.csrfToken }, extraHeaders: { Origin: origin, Cookie: cookie } });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error(name + ' handshake timeout')); }, 15000);
    socket.once('connect', () => { clearTimeout(timer); socket.disconnect(); resolve(); });
    socket.once('connect_error', () => { clearTimeout(timer); socket.disconnect(); reject(new Error(name + ' handshake failed')); });
  });
}

(async () => {
  state.startedAt ??= new Date().toISOString(); save();
  const active = state.currentProject || project;
  const backend = await inspect(active + '-backend-1');
  assert.equal(backend.Config.Labels['com.docker.compose.project'], active);
  assert.equal(backend.State.Health.Status, 'healthy');
  assert.equal((await fetch(origin + '/login')).status, 200);
  for (let index = 0; index < 2; index++) {
    const context = await chromium.launchPersistentContext(path.join(directory, 'compose-profiles', state.seed + '-' + index), {
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(context); const page = context.pages()[0] || await context.newPage(); pages.push(page);
    page.on('request', request => { if ((request.postData() || '').includes('Synthetic Docker message ' + state.seed)) plaintextLeaks++; });
    page.on('websocket', socket => {
      socket.on('framesent', ({ payload }) => { websocketFrames++; if (String(payload).includes('Synthetic Docker message ' + state.seed)) plaintextLeaks++; });
    });
  }
  await stage('functional-browser', async () => {
    state.initialDatabase ??= await snapshot(project); save();
    for (const [index, page] of pages.entries()) {
      const account = { username: 'docker-' + (index ? 'bob-' : 'alice-') + state.seed, displayName: index ? 'Bob' : 'Alice' };
      await page.goto(origin + '/signup');
      await page.getByLabel('Username', { exact: true }).fill(account.username);
      await page.getByLabel('Email', { exact: true }).fill(account.username + '@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByLabel('Confirm password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Create Account', exact: true }).click();
      await expect(page.getByText('Account created. Sign in to continue.', { exact: true })).toBeVisible({ timeout: 30000 });
      check('registration requires explicit login ' + index);
      await login(page, account);
      const me = await api(page, '/api/auth/me'); assert.equal(me.status, 200); account.id = me.body.user.id;
      assert.equal((await api(page, '/api/users/me', 'PATCH', { displayName: account.displayName })).status, 200);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Your conversations', exact: true })).toBeVisible();
      await enroll(page); const stored = await device(page, account.id); assert.ok(stored.nonExtractable);
      account.deviceId = stored.id; state.accounts[index] = account; save(); check('login and non-extractable enrollment ' + index);
    }
    const sent = await api(pages[0], '/api/friends/requests', 'POST', { userId: state.accounts[1].id }); assert.equal(sent.status, 201);
    assert.equal((await api(pages[1], '/api/friends/requests/' + sent.body.request.id + '/accept', 'POST')).status, 200);
    check('friend request and acceptance through same-origin browser API');
    await pages[0].reload();
    await expect(pages[0].getByText('Secure device ready', { exact: true })).toBeVisible();
    await pages[0].getByRole('button', { name: /^Friends(?:,|$)/ }).click();
    await pages[0].getByRole('button', { name: 'Message Bob', exact: true }).click();
    await expect(pages[0].getByText('Secure message ready', { exact: true })).toBeVisible({ timeout: 45000 });
    await select(pages[1], 'Alice'); await connected(pages[0]);
    await send(pages[0], pages[1]); await send(pages[1], pages[0]);
    check('real UI creates direct conversation and exchanges live encrypted messages');
    await recover(); check('refresh restores session, device identity and decryptable history');
    await transport(pages[0], contexts[0], 'polling'); check('authenticated Socket.IO polling through Compose proxy');
    await transport(pages[0], contexts[0], 'websocket'); check('authenticated Socket.IO WebSocket through Compose proxy');
    const denied = await fetch(origin + '/api/auth/me', { headers: { Origin: 'http://unapproved.example.test' } }); assert.equal(denied.status, 403);
    const missing = await pages[0].evaluate(async () => (await fetch('/api/friends/requests', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    assert.equal(missing, 403); check('unapproved Origin and missing CSRF remain rejected');
    const cookies = await contexts[0].cookies(origin), session = cookies.find(cookie => cookie.name === 'secubuzz_session');
    assert.ok(session?.httpOnly && session.sameSite === 'Lax' && !session.secure); check('existing explicit local HTTP cookie policy preserved');
    const baseline = await snapshot(project); state.baseline = baseline; save();
    assert.equal(baseline.snapshot.Users.count, state.initialDatabase.snapshot.Users.count + 2);
    assert.equal(baseline.snapshot.Messages.count, state.initialDatabase.snapshot.Messages.count + 2);
    assert.ok(baseline.files.includes('database.sqlite-wal') && baseline.files.includes('database.sqlite-shm'));
    check('canonical ledger, WAL sidecars, private permissions and unique synthetic records');
  });
  if (!state.stages['backup-restore']?.passed) await recover();
  await stage('backend-restart', async () => {
    const before = await snapshot(project);
    await compose(project, ['restart', 'backend']);
    await compose(project, ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180']);
    await connected(pages[0]); await connected(pages[1]);
    await select(pages[0], 'Bob'); await select(pages[1], 'Alice');
    assert.deepEqual((await snapshot(project)).snapshot, before.snapshot);
    await send(pages[0], pages[1]); check('backend restart reconnects and resumes live delivery without duplicate records');
  });
  for (const [name, commands] of [
    ['compose-restart', [['restart'], ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180']]],
    ['compose-down-up', [['down'], ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180']]],
    ['container-recreation', [['up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180']]],
    ['image-rebuild', [['up', '--build', '-d', '--wait', '--wait-timeout', '180']]],
  ]) await stage(name, async () => {
    const before = await snapshot(project);
    for (const args of commands) await compose(project, args);
    await namespace(project); await recover();
    assert.deepEqual((await snapshot(project)).snapshot, before.snapshot);
    check(name + ' retains database records and browser keys');
  });
  await stage('backend-replacement', async () => {
    const before = await snapshot(project), old = (await inspect(project + '-backend-1')).Id;
    const result = await compose(project, ['up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '120', 'backend'], true);
    const replacement = await inspect(project + '-backend-1'); assert.notEqual(replacement.Id, old);
    const frontend = await inspect(project + '-frontend-1');
    state.backendOnlyReplacement = { exitCode: result.code, automaticReattachment: frontend.HostConfig.NetworkMode === 'container:' + replacement.Id }; save();
    if (!state.backendOnlyReplacement.automaticReattachment || result.code) {
      await compose(project, ['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'frontend']);
      state.backendOnlyReplacement.explicitFrontendRecreation = true; save();
    }
    await namespace(project); await recover(); assert.deepEqual((await snapshot(project)).snapshot, before.snapshot);
    await send(pages[1], pages[0]); check('backend replacement and frontend namespace recovery retain data and resume live messaging');
  });
  await stage('backup-restore', async () => {
    const before = await snapshot(project); state.backupSnapshot = before; save();
    await compose(project, ['stop']);
    for (const [volume, archive] of [['sqlite-data','sqlite-backup.tar'], ['private-storage','attachments-backup.tar']]) {
      await command(['run','--rm','--network','none','--user','0','--mount',`type=volume,source=${project}_${volume},target=/volume,readonly`,
        '--mount',`type=bind,source=${directory},target=/evidence`,project + '-backend:latest','tar','-C','/volume','-cpf','/evidence/' + archive,'.']);
    }
    const restored = project + '-restore-' + randomUUID().slice(0, 6); state.currentProject = restored; save();
    fs.writeFileSync(path.join(directory,'restore-images.json'), JSON.stringify({ services: { backend: { image: project + '-backend:latest' }, frontend: { image: project + '-frontend:latest' } } }, null, 2));
    for (const [volume, archive] of [['sqlite-data','sqlite-backup.tar'], ['private-storage','attachments-backup.tar']]) {
      const target = restored + '_' + volume;
      await command(['volume','create','--label','com.docker.compose.project=' + restored,'--label','com.docker.compose.volume=' + volume,target]);
      await command(['run','--rm','--network','none','--user','0','--mount',`type=volume,source=${target},target=/volume`,
        '--mount',`type=bind,source=${directory},target=/evidence,readonly`,project + '-backend:latest','tar','-C','/volume','-xpf','/evidence/' + archive]);
    }
    await compose(restored, ['up','-d','--no-build','--wait','--wait-timeout','180']);
    const after = await snapshot(restored); assert.deepEqual(after.snapshot, before.snapshot);
    assert.equal(after.integrity,'ok'); assert.equal(after.foreignKeyViolations,0);
    await namespace(restored); await recover();
    state.restoredSnapshot = after; save(); check('cold backup restores into fresh volumes with integrity, ledger, records and browser decryption intact');
  });
  await stage('same-profile-account-switch', async () => {
    const alice = pages[0];
    await alice.getByRole('button',{name:'Sign Out',exact:true}).click();
    await expect(alice.getByLabel('Username or email')).toBeVisible({timeout:30000});
    await login(alice,state.accounts[1]);
    await expect(alice.getByRole('button',{name:/^Enroll this browser/})).toBeVisible();
    check('same browser profile does not reuse another account device identity');
    await alice.getByRole('button',{name:'Sign Out',exact:true}).click();
    await expect(alice.getByLabel('Username or email')).toBeVisible({timeout:30000});
    await login(alice,state.accounts[0]);
    await expect(alice.getByText('Secure device ready',{exact:true})).toBeVisible();
    await select(alice,'Bob'); assert.equal((await device(alice,state.accounts[0].id)).id,state.accounts[0].deviceId);
    await expect(alice.getByRole('log').getByText(message(1),{exact:true})).toHaveCount(1);
    check('logout/login restores original account-scoped browser keys and history');
  });
  check('no synthetic message plaintext observed in HTTP or WebSocket sends',plaintextLeaks===0);
  state.webSocketFramesObserved = websocketFrames; state.passed = true; state.finishedAt = new Date().toISOString(); save();
})().catch(error => {
  state.passed = false; state.failure = String(error.message).split('\n')[0].replaceAll(password,'[redacted]').slice(0,250); save();
  console.error('Compose acceptance failed: ' + state.failure); process.exitCode = 1;
}).finally(async () => { for (const context of contexts) await context.close().catch(() => {}); });
