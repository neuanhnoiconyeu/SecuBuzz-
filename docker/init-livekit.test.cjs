'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeLiveKit } = require('./init-livekit.cjs');
const fixture = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secubuzz-livekit-test-')), 'livekit');
test('local credentials are random, server-only, match SFU config and retain strict room creation', () => {
  const dir = fixture(); assert.equal(initializeLiveKit(dir), true);
  const env = fs.readFileSync(path.join(dir, 'backend.env'), 'utf8'), config = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
  const values = Object.fromEntries(env.trim().split('\n').map(line => line.split('=')));
  assert.match(values.LIVEKIT_API_KEY, /^[a-f0-9]{36}$/); assert.match(values.LIVEKIT_API_SECRET, /^[a-f0-9]{96}$/);
  assert(config.includes(`${values.LIVEKIT_API_KEY}: ${values.LIVEKIT_API_SECRET}`));
  assert(config.includes('auto_create: false')); assert(config.includes('node_ip: 127.0.0.1')); assert(!env.includes('NEXT_PUBLIC_'));
  const second = fixture(); initializeLiveKit(second); assert.notEqual(fs.readFileSync(path.join(second, 'backend.env'), 'utf8'), env);
});
test('repeated initialization preserves exact credentials instead of rotating them', () => {
  const dir = fixture(); initializeLiveKit(dir); const env = fs.readFileSync(path.join(dir, 'backend.env'));
  assert.equal(initializeLiveKit(dir), false); assert.deepEqual(fs.readFileSync(path.join(dir, 'backend.env')), env);
});
test('incomplete existing configuration fails without overwriting its remaining data', () => {
  const dir = fixture(); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'backend.env'), 'PRESERVE');
  assert.throws(() => initializeLiveKit(dir)); assert.equal(fs.readFileSync(path.join(dir, 'backend.env'), 'utf8'), 'PRESERVE');
});
test('local secrets stay outside Docker build contexts and overlay publishes only loopback ports', () => {
  const root = path.join(__dirname, '..');
  assert(fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').includes('**/secrets'));
  assert(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('secrets/'));
  const overlay = fs.readFileSync(path.join(root, 'compose.calls.yaml'), 'utf8');
  for (const port of ['7880:7880','7881:7881','7882:7882/udp']) assert(overlay.includes('127.0.0.1:' + port));
  assert(overlay.includes('network_mode: service:backend')); assert(!overlay.includes('API_SECRET'));
});
