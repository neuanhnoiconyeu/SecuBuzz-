const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const dist = '.next-e2ee-build-' + randomUUID().slice(0, 8);
// Compile production output independently of any running dev/production asset directory.
// The compile-only HTTPS origin is not contacted, deployed, or written into a user .env file.
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', CLIENT_TEST_DIST_DIR: dist,
    AUTH_BACKEND_URL: process.env.E2EE_BUILD_BACKEND_URL || 'https://data.invalid' },
});
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
