'use strict';
// Real SFU acceptance. Adds two synthetic accounts; never resets existing data or exports browser keys.
const { chromium, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
let origin = 'http://localhost:3001';
const evidenceDir = path.resolve(__dirname, '../../.cache/phase10c-calls-' + randomBytes(4).toString('hex'));
const evidence = { origin, syntheticDevices: true, realLiveKit: true, checks: [], media: [], errors: 0, attachmentRequests: 0, passed: false };
const ownedServices = [];
async function isolated() {
  const port = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
  const backendPort = await port(), frontendPort = await port(), client = path.resolve(__dirname, '..'), root = path.resolve(client, '..');
  origin = `http://localhost:${frontendPort}`; evidence.origin = origin;
  const env = Object.fromEntries(fs.readFileSync(path.join(root, 'docker/secrets/livekit/backend.env'), 'utf8').trim().split('\n').map(l => l.split('=')));
  const start = (args, cwd, extra) => { const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...extra }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); ownedServices.push(p); p.on('error', () => {}); };
  const healthy = async url => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {} await new Promise(r => setTimeout(r, 500)); } throw Error('Disposable service startup failed'); };
  start(['src/data/main.ts'], path.join(root, 'server'), { ...env, NODE_ENV: 'test', DATA_ROOT: path.join(root, 'DATA'), DB_PATH: path.join(evidenceDir, 'isolated.sqlite'), HOST: '127.0.0.1', PORT: String(backendPort), AUTH_ALLOWED_ORIGINS: origin, AUTH_ALLOW_HTTP_LOCAL: 'true' });
  await healthy(`http://127.0.0.1:${backendPort}/healthz`);
  start([require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(frontendPort)], client,
    { NODE_ENV: 'development', AUTH_BACKEND_URL: `http://127.0.0.1:${backendPort}`, NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true', NEXT_PUBLIC_AUTH_API_BASE_PATH: '/api/auth', NEXT_PUBLIC_LIVEKIT_ENABLED: 'false', NEXT_PUBLIC_DIRECT_CALLS_ENABLED: 'true', NEXT_PUBLIC_LIVEKIT_URL: env.LIVEKIT_URL, CLIENT_TEST_DIST_DIR: '.next-e2ee-calls-' + path.basename(evidenceDir).split('-').at(-1) });
  await healthy(origin + '/login');
}
const check = (name, condition) => { evidence.checks.push({ name, passed: Boolean(condition) }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) throw Error(name); };
async function api(page, route, method = 'GET', body) {
  return page.evaluate(async ({ route, method, body }) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { const csrf = await (await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })).json(); headers['X-CSRF-Token'] = csrf.csrfToken; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(route, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  }, { route, method, body });
}
async function select(page, name) {
  await page.reload(); await expect(page.getByRole('status', { name: 'Live connection' })).toContainText('Connected', { timeout: 60000 });
  await page.getByRole('navigation', { name: 'Direct conversations' }).getByRole('button', { name: new RegExp('^' + name + ',') }).click();
  await expect(page.getByRole('button', { name: 'Voice call ' + name, exact: true })).toBeEnabled({ timeout: 30000 });
}
async function stats(page) {
  return page.evaluate(async () => {
    const rows = [];
    for (const pc of window.__callPCs.filter(pc => pc.connectionState === 'connected')) {
      for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && !s.isRemote) rows.push({ kind: s.kind, bytes: s.bytesReceived || 0, packets: s.packetsReceived || 0, frames: s.framesDecoded || 0, energy: s.totalAudioEnergy || 0, samples: s.totalSamplesReceived || 0 });
    }
    return rows;
  });
}
async function media(page, label, video) {
  await expect.poll(async () => (await stats(page)).some(s => s.kind === 'audio' && s.bytes > 0 && s.samples > 0 && s.energy > 0), { timeout: 45000 }).toBe(true);
  await expect.poll(() => page.locator('.voice-audio-output audio').evaluateAll(nodes => nodes.some(n => n.srcObject?.getAudioTracks().some(t => t.readyState === 'live') && n.currentTime > 0 && !n.paused)), { timeout: 20000 }).toBe(true);
  if (video) {
    await expect.poll(async () => (await stats(page)).some(s => s.kind === 'video' && s.bytes > 0 && s.frames > 0), { timeout: 30000 }).toBe(true);
    await expect.poll(() => page.locator('video:not(.is-local)').evaluateAll(nodes => nodes.some(n => n.videoWidth > 0 && n.getVideoPlaybackQuality().totalVideoFrames > 0)), { timeout: 20000 }).toBe(true);
  }
  evidence.media.push({ label, video, inbound: await stats(page) });
  check(label + ' receives decoded remote audio' + (video ? ' and video frames' : ''), true);
}
async function closed(pages) {
  for (const page of pages) {
    await expect(page.getByRole('button', { name: 'Close call', exact: true })).toBeVisible({ timeout: 45000 });
    await page.getByRole('button', { name: 'Close call', exact: true }).click();
    // The SDK can allocate an unused replacement transport after device changes.
    // All negotiated transports must close; an idle transport has no SDP or sender tracks.
    await expect.poll(() => page.evaluate(() => window.__callTracks.every(t => t.readyState === 'ended') && window.__callPCs.every(pc => pc.connectionState === 'closed' ||
      pc.connectionState === 'new' && !pc.localDescription && !pc.remoteDescription && pc.getSenders().every(s => !s.track))), { timeout: 20000 }).toBe(true);
    await expect(page.locator('.voice-audio-output audio')).toHaveCount(0);
  }
}
(async () => {
  fs.mkdirSync(evidenceDir, { recursive: true }); let browser; const contexts = [], pages = [];
  try {
    if (process.argv.includes('--isolated')) await isolated();
    // A deterministic valid Y4M source avoids host-camera availability in headless checks.
    const videoFixture = path.join(evidenceDir, 'synthetic.y4m'), width = 320, height = 240;
    const frames = [Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`)];
    for (let i = 0; i < 30; i++) { const pixels = Buffer.alloc(width * height * 3 / 2, 128); pixels.fill(30 + i * 6, 0, width * height); frames.push(Buffer.from('FRAME\n'), pixels); }
    fs.writeFileSync(videoFixture, Buffer.concat(frames));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + videoFixture, '--autoplay-policy=no-user-gesture-required'] });
    const suffix = randomBytes(4).toString('hex'), password = randomBytes(24).toString('base64url'), users = [];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1440, height: 1000 } }); contexts.push(context);
      await context.addInitScript(() => {
        window.__callPCs = []; window.__callTracks = []; window.__callCaptures = [];
        const NativePC = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePC { constructor(...args) { super(...args); window.__callPCs.push(this); } };
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
          const observed = { audio: Boolean(options.audio), video: options.video, state: 'pending' }; window.__callCaptures.push(observed);
          try { const s = await capture(options); observed.state = 'resolved'; window.__callTracks.push(...s.getTracks()); return s; }
          catch (e) { observed.state = e.name; throw e; }
        };
      });
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', () => { evidence.errors++; });
      page.on('request', r => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/attachments') && p !== '/api/attachments/limits') evidence.attachmentRequests++; });
      page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
        const value = String(payload); if (!/^42\d*\[/.test(value)) return;
        try { const data = JSON.parse(value.slice(value.indexOf('['))); if (data[0] === 'call:initiate') { evidence.initiatedKinds ??= []; evidence.initiatedKinds.push(data[1]?.kind); } } catch { /* Only record the bounded kind, never credentials or tokens. */ }
      }));
      await page.goto(origin + '/login');
      const username = 'call10c-' + i + '-' + suffix, displayName = i ? 'Call Bob' : 'Call Alice';
      check('synthetic account registration ' + i, (await api(page, '/api/auth/register', 'POST', { username, email: username + '@example.test', displayName, password })).status === 201);
      await page.getByLabel('Username or email').fill(username); await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Your conversations', exact: true })).toBeVisible({ timeout: 60000 });
      users.push((await api(page, '/api/auth/me')).body.user);
    }
    const [alice, bob] = pages;
    const friend = await api(alice, '/api/friends/requests', 'POST', { userId: users[1].id }); check('authorized friendship request', friend.status === 201);
    check('authorized friendship acceptance', (await api(bob, '/api/friends/requests/' + friend.body.request.id + '/accept', 'POST')).status === 200);
    check('authorized direct conversation', [200, 201].includes((await api(alice, '/api/conversations/dm', 'POST', { recipientId: users[1].id })).status));
    await select(alice, 'Call Bob'); await select(bob, 'Call Alice');
    check('call controls use real authenticated workspace', true);
    check('unauthorized call token is denied', [403, 404].includes((await api(alice, '/api/calls/token', 'POST', { callId: '00000000-0000-4000-8000-000000000000', connectionId: 'not-the-owner' })).status));
    const noCsrf = await alice.evaluate(() => fetch('/api/calls/token', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)); check('token endpoint preserves CSRF', noCsrf === 403);
    const invite = async kind => { await alice.getByRole('button', { name: `${kind} call Call Bob`, exact: true }).click(); await expect(bob.getByRole('button', { name: 'Answer', exact: true })).toBeEnabled({ timeout: 20000 }); };
    const accept = async kind => { await invite(kind); await bob.getByRole('button', { name: 'Answer', exact: true }).click(); for (const page of pages) await expect(page.locator('.direct-call-status')).toHaveAttribute('data-state', 'connected', { timeout: 45000 }); };
    if (process.argv.includes('--video-only')) {
      await accept('Video'); await media(alice, 'Video Alice', true); await media(bob, 'Video Bob', true);
      await alice.getByRole('button', { name: 'Hang up call', exact: true }).click(); await closed(pages); evidence.passed = true; return;
    }
    await accept('Voice'); await media(alice, 'Voice Alice', false); await media(bob, 'Voice Bob', false);
    await alice.getByRole('button', { name: 'Mute call microphone', exact: true }).click(); await expect(alice.getByRole('button', { name: 'Unmute call microphone', exact: true })).toBeEnabled(); check('microphone mute applies', true);
    const mutedBytes = (await stats(bob)).filter(s => s.kind === 'audio').reduce((sum, s) => sum + s.bytes, 0);
    await alice.getByRole('button', { name: 'Unmute call microphone', exact: true }).click();
    await expect.poll(async () => (await stats(bob)).filter(s => s.kind === 'audio').reduce((sum, s) => sum + s.bytes, 0), { timeout: 20000 }).toBeGreaterThan(mutedBytes + 100);
    await media(bob, 'Voice Bob after unmute', false);
    await alice.getByRole('button', { name: 'Hang up call', exact: true }).click(); await closed(pages); check('voice end releases captured tracks and peer connections', true);
    await accept('Video'); await media(alice, 'Video Alice', true); await media(bob, 'Video Bob', true);
    await alice.getByRole('button', { name: 'Turn call camera off', exact: true }).click(); await expect(alice.getByRole('button', { name: 'Turn call camera on', exact: true })).toBeEnabled();
    await expect(bob.locator('video:not(.is-local)')).toHaveCount(0, { timeout: 15000 }); check('camera off removes remote camera presentation', true);
    await alice.getByRole('button', { name: 'Turn call camera on', exact: true }).click(); await media(bob, 'Video Bob after camera restart', true);
    await bob.getByRole('button', { name: 'Hang up call', exact: true }).click(); await closed(pages); check('video end cleans both participants', true);
    await invite('Voice'); await bob.getByRole('button', { name: 'Decline', exact: true }).click(); await closed(pages); check('incoming rejection synchronizes without capture', true);
    await invite('Voice'); await alice.getByRole('button', { name: 'Hang up call', exact: true }).click(); await closed(pages); check('outgoing cancellation synchronizes', true);
    const permission = await contexts[0].newCDPSession(alice);
    const { targetInfo } = await permission.send('Target.getTargetInfo');
    const permissionScope = { origin, browserContextId: targetInfo.browserContextId };
    await permission.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', ...permissionScope });
    await accept('Voice'); await expect(alice.getByText(/Microphone permission was denied/)).toBeVisible({ timeout: 20000 });
    await expect(alice.getByRole('button', { name: 'Unmute call microphone', exact: true })).toBeEnabled(); await media(alice, 'Permission-denied Alice can still listen', false);
    check('denied microphone is reported without ending incoming audio', true);
    await permission.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', ...permissionScope });
    await alice.getByRole('button', { name: 'Unmute call microphone', exact: true }).click(); await media(bob, 'Bob after permission recovery', false);
    await alice.getByRole('button', { name: 'Hang up call', exact: true }).click(); await closed(pages); await permission.detach();
    // Restore the context's permission override after detaching the temporary CDP session.
    await contexts[0].grantPermissions(['microphone', 'camera'], { origin });
    await expect.poll(() => alice.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then(p => p.state))).toBe('granted');
    await alice.route('**/api/calls/token', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }) }));
    await invite('Voice'); await bob.getByRole('button', { name: 'Answer', exact: true }).click(); await closed(pages); await alice.unroute('**/api/calls/token'); check('token failure stops call and releases media', true);
    await accept('Voice'); await media(alice, 'Recovered voice Alice', false); await media(bob, 'Recovered voice Bob', false);
    await alice.getByRole('button', { name: 'Hang up call', exact: true }).click(); await closed(pages); check('a new call recovers after failure', true);
    check('live calls never use attachment storage', evidence.attachmentRequests === 0);
    check('no browser runtime exceptions', evidence.errors === 0); evidence.passed = true;
  } catch (error) {
    evidence.failure = String(error.message).replace(/access_token=[^&\s]+/g, 'access_token=[redacted]'); console.error(evidence.failure);
    evidence.diagnostics = await Promise.all(pages.map(async page => ({ inbound: await stats(page).catch(() => []), ui: await page.evaluate(() => ({ captures: window.__callCaptures, peers: window.__callPCs.map(p => ({ state: p.connectionState, ice: p.iceConnectionState, signaling: p.signalingState, local: Boolean(p.localDescription), remote: Boolean(p.remoteDescription), senders: p.getSenders().map(s => s.track?.readyState) })), tracks: window.__callTracks.map(t => ({ kind: t.kind, state: t.readyState })), alerts: [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent), callState: document.querySelector('.direct-call-status')?.dataset.state })).catch(() => null) })));
    for (const [i, page] of pages.entries()) await page.screenshot({ path: path.join(evidenceDir, 'failure-' + i + '.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    // Logout only the synthetic sessions; account/conversation records remain intact.
    for (const page of pages) await api(page, '/api/auth/logout', 'POST').catch(() => {});
    for (const context of contexts) await context.close().catch(() => {}); await browser?.close();
    for (const child of ownedServices.reverse()) {
      if (child.exitCode !== null) continue;
      if (process.platform === 'win32') await new Promise(resolve => { const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); stop.once('exit', resolve); stop.once('error', resolve); });
      else child.kill('SIGTERM');
    }
    fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log('Evidence: ' + evidenceDir);
  }
})();
