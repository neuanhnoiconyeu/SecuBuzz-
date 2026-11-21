'use strict';

const http = require('node:http');
const role = process.argv[2];
if (!['backend', 'frontend'].includes(role)) process.exit(1);
const backend = role === 'backend';
const request = http.get({
  hostname: '127.0.0.1',
  port: backend ? 5000 : 3001,
  path: backend ? '/healthz' : '/login',
  timeout: backend ? 3000 : 8000,
}, (response) => {
  let body = '';
  response.on('data', (chunk) => { if (backend) body += chunk; });
  response.on('end', () => {
    if (response.statusCode !== 200) return process.exit(1);
    if (backend) {
      try { if (JSON.parse(body).status !== 'ok') return process.exit(1); }
      catch { return process.exit(1); }
    }
    process.exit(0);
  });
  response.on('error', () => process.exit(1));
});
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));
