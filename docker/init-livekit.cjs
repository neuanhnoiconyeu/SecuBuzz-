'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

/** Local development only. Never overwrite credentials already used by the project. */
function initializeLiveKit(directory = path.join(__dirname, 'secrets/livekit')) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local LiveKit setup is not a production configuration.');
  if (fs.existsSync(directory)) {
    for (const name of ['backend.env', 'config.yaml']) {
      if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error('Incomplete LiveKit setup; preserve and review the existing files.');
    }
    return false;
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(directory), '.livekit-'));
  const key = randomBytes(18).toString('hex'), secret = randomBytes(48).toString('hex');
  const env = `LIVEKIT_ENABLED=true\nLIVEKIT_URL=ws://localhost:7880\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${secret}\n`;
  const config = `port: 7880\nbind_addresses: [0.0.0.0]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: 127.0.0.1\nroom:\n  auto_create: false\n  max_participants: 2\nkeys:\n  ${key}: ${secret}\nlogging:\n  level: warn\n`;
  fs.writeFileSync(path.join(staging, 'backend.env'), env, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(staging, 'config.yaml'), config, { mode: 0o600, flag: 'wx' });
  fs.renameSync(staging, directory);
  return true;
}
module.exports = { initializeLiveKit };
if (require.main === module) {
  try { console.log(initializeLiveKit() ? 'Created local LiveKit configuration in ignored docker/secrets/livekit. No credentials printed.' : 'Existing local LiveKit configuration preserved.'); }
  catch { console.error('LiveKit setup failed. Existing configuration was preserved; review it without exposing credentials.'); process.exitCode = 1; }
}
