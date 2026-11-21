'use strict';

// Keep the existing npm commands and forward shutdown to their entire Linux
// process group (npm, its shell, and Node/Next). Docker init reaps descendants.
const { spawn } = require('node:child_process');

const commands = {
  backend: ['--prefix', 'server', 'run', 'start:data'],
  frontend: ['--prefix', 'client', 'run', 'dev', '--', '--hostname', '0.0.0.0', '--port', '3001'],
};
const args = commands[process.argv[2]];
if (!args || process.platform !== 'linux') {
  console.error('Use this Docker launcher only inside the Linux development image.');
  process.exit(1);
}

let stopping = false;
const child = spawn('npm', args, { stdio: 'inherit', detached: true });
function stop(signal) {
  if (stopping) return;
  stopping = true;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') process.exitCode = 1; }
}
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
child.once('error', () => {
  console.error('The Docker application command could not start.');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = stopping && (code === null || code === 130 || code === 143)
    ? 0 : (code ?? 1);
});
