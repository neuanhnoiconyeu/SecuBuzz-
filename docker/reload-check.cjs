'use strict';

// Windows source-reload and cache-invalidation checks; restore exact source bytes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), artifactRoot = path.join(root, 'docker/artifacts');
const directory = path.resolve(process.env.SECUBUZZ_DOCKER_EVIDENCE_DIR || path.join(artifactRoot, 'infra01c'));
assert.ok(directory.toLowerCase().startsWith((artifactRoot + path.sep).toLowerCase()));
const acceptance = JSON.parse(fs.readFileSync(path.join(directory, 'compose-acceptance.json'), 'utf8'));
assert.equal(process.env.SECUBUZZ_DOCKER_VALIDATION, 'true'); assert.equal(acceptance.passed, true);
const project = acceptance.currentProject || acceptance.project;
assert.match(project, /^secubuzz-infra01c-[a-z0-9-]+$/);
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');
const evidence = { project, startedAt: new Date().toISOString(), checks: [] };
const save = () => fs.writeFileSync(path.join(directory, 'reload-results.json'), JSON.stringify(evidence, null, 2));
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const extra = acceptance.currentProject ? ['-f', 'compose.yaml', '-f', path.join(directory, 'restore-images.json')] : [];
const composeArgs = args => ['compose', '-p', project, ...extra, ...args];
let browser, watcher;
const cssFile = path.join(root, 'client/src/app/globals.css'), mainFile = path.join(root, 'server/src/data/main.ts'), lockFile = path.join(root, 'client/package-lock.json');
const original = new Map([cssFile, mainFile, lockFile].map(file => [file, fs.readFileSync(file)]));
async function command(args, input) {
  const child = spawn('docker', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output += value.toString(); });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 1)); });
  fs.appendFileSync(path.join(directory, 'reload-commands.log'), JSON.stringify({ args, exitCode: code }) + '\n' + output + '\n');
  assert.equal(code, 0, 'Docker reload command failed'); return output;
}
async function inspect() { return JSON.parse(await command(['inspect', project + '-backend-1']))[0]; }
async function snapshot() {
  return JSON.parse(await command(composeArgs(['exec','-T','-e','SECUBUZZ_DOCKER_VALIDATION=true','backend','node','--input-type=commonjs']), fs.readFileSync(path.join(__dirname,'database-check.cjs'))));
}
function check(name) { evidence.checks.push({ name, passed: true }); save(); console.log('PASS ' + name); }
async function stopWatcher() {
  if (!watcher || watcher.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(watcher.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => killer.once('exit', resolve));
  } else watcher.kill('SIGTERM');
  watcher = undefined;
}
(async () => {
  const started = Date.now(), before = await snapshot();
  browser = await chromium.launchPersistentContext(path.join(directory, 'reload-profile-' + randomUUID().slice(0,8)), {
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('http://localhost:3001/login');
  const timeOrigin = await page.evaluate(() => performance.timeOrigin), marker = 'probe' + randomUUID().replaceAll('-','');
  const previous = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--infra01c-marker').trim());
  try {
    fs.writeFileSync(cssFile, Buffer.concat([original.get(cssFile), Buffer.from('\n:root { --infra01c-marker: ' + marker + '; }\n')]));
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--infra01c-marker').trim()), { timeout: 45000 }).toBe(marker);
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    check('Windows frontend source edit hot-reloads CSS without browser navigation');
  } finally { fs.writeFileSync(cssFile, original.get(cssFile)); }
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--infra01c-marker').trim()), { timeout: 45000 }).toBe(previous);
  check('frontend source restoration is detected');

  let watchOutput = '';
  watcher = spawn('docker', composeArgs(['watch','--no-up','backend']), { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [watcher.stdout, watcher.stderr]) stream.on('data', buffer => { watchOutput += buffer.toString(); });
  await expect.poll(() => /watch.*enabled|watching|watch.*started/i.test(watchOutput), { timeout: 30000 }).toBe(true);
  await delay(1500);
  const modified = Buffer.concat([original.get(mainFile), Buffer.from('\n// INFRA-01C temporary source-reload probe.\n')]);
  try {
    const first = (await inspect()).State.StartedAt;
    fs.writeFileSync(mainFile, modified);
    await expect.poll(async () => (await inspect()).State.StartedAt, { timeout: 60000, intervals: [1000] }).not.toBe(first);
    await expect.poll(async () => (await command(['exec',project+'-backend-1','sha256sum','/workspace/server/src/data/main.ts'])).split(/\s/)[0], { timeout: 30000 }).toBe(hash(modified));
    check('Compose Watch syncs Windows backend source and restarts the unified container');
    const changed = (await inspect()).State.StartedAt;
    fs.writeFileSync(mainFile, original.get(mainFile));
    await expect.poll(async () => (await inspect()).State.StartedAt, { timeout: 60000, intervals: [1000] }).not.toBe(changed);
    await expect.poll(async () => (await command(['exec',project+'-backend-1','sha256sum','/workspace/server/src/data/main.ts'])).split(/\s/)[0], { timeout: 30000 }).toBe(hash(original.get(mainFile)));
    check('Compose Watch detects restoration of the original backend source');
  } finally {
    fs.writeFileSync(mainFile, original.get(mainFile));
    fs.writeFileSync(path.join(directory,'compose-watch.log'), watchOutput);
    await stopWatcher();
  }
  await command(composeArgs(['up','-d','--no-build','--wait','--wait-timeout','180']));

  try {
    fs.writeFileSync(lockFile, Buffer.concat([original.get(lockFile),Buffer.from('\n')]));
    const output = await command(composeArgs(['--progress','plain','build','frontend']));
    assert.match(output,/RUN npm --prefix client ci/);
    assert.match(output,/added \d+ packages/);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile,'utf8')),JSON.parse(original.get(lockFile).toString('utf8')));
    check('semantically unchanged lockfile edit invalidates the Linux npm ci build layer');
  } finally { fs.writeFileSync(lockFile, original.get(lockFile)); }
  await command(composeArgs(['up','--build','-d','--wait','--wait-timeout','180']));
  assert.deepEqual((await snapshot()).snapshot,before.snapshot);
  check('rebuild after lockfile restoration retains synthetic records');
  for (const [file, bytes] of original) assert.equal(hash(fs.readFileSync(file)),hash(bytes));
  check('all temporary source and lockfile changes restored byte-for-byte');
  evidence.passed = true; evidence.seconds = Number(((Date.now()-started)/1000).toFixed(2)); save();
})().catch(error => {
  evidence.passed = false; evidence.failure = String(error.message).split('\n')[0].slice(0,250); save();
  console.error('Reload validation failed: '+evidence.failure); process.exitCode=1;
}).finally(async () => {
  for (const [file, bytes] of original) fs.writeFileSync(file,bytes);
  await stopWatcher(); await browser?.close().catch(()=>{});
});
