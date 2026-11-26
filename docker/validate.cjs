'use strict';

// Run existing commands unchanged in a disposable Linux image with no host
// source/database mounts. Only /evidence is writable on the host.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
assert.equal(process.platform, 'linux');
assert.equal(process.env.SECUBUZZ_DOCKER_VALIDATION, 'true');
assert.ok(!fs.existsSync('/workspace/DATA/.env'));
assert.ok(!fs.existsSync('/workspace/server/.env'));
const groups = {
  client: [
    ['client-unit', 'client', ['test', '--', '--runInBand', '--json', '--outputFile=/evidence/client-jest.json']],
    ['client-types', 'client', ['run', 'type-check']],
    ['client-lint', 'client', ['run', 'lint']],
    ['client-build', 'client', ['run', 'build:verify']],
  ],
  server: [
    ['server-types', 'server', ['run', 'type-check']],
    ['server-tests', 'server', ['test']],
  ],
  data: [['data-tests', 'DATA', ['test']]],
  browser: [
    ['e2ee-browser', 'client', ['run', 'test:e2ee:browser']],
    ['realtime-browser', 'client', ['run', 'test:realtime:browser']],
  ],
};
const DEFAULT_EXTERNAL_TIMEOUT_SECONDS = 720;
const MAX_EXTERNAL_TIMEOUT_SECONDS = 1800;
function parseExternalTimeout(value) {
  if (value === undefined) return DEFAULT_EXTERNAL_TIMEOUT_SECONDS;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('SECUBUZZ_VALIDATION_TIMEOUT_SECONDS must be a positive whole number of seconds.');
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_EXTERNAL_TIMEOUT_SECONDS) throw new Error('SECUBUZZ_VALIDATION_TIMEOUT_SECONDS must be between 1 and 1800 seconds.');
  return seconds;
}
let externalTimeoutSeconds;
try { externalTimeoutSeconds = parseExternalTimeout(process.env.SECUBUZZ_VALIDATION_TIMEOUT_SECONDS); }
catch (error) { console.error(error.message); process.exit(2); }
const group = process.argv[2];
assert.ok(Object.hasOwn(groups, group));
fs.mkdirSync('/evidence', { recursive: true });

async function run([name, directory, args]) {
  const started = Date.now();
  const logfile = fs.createWriteStream('/evidence/' + name + '.log');
  let logError = null;
  logfile.on('error', error => { logError = error; });
  let output = '';
  console.log('RUN ' + name + ': npm ' + args.join(' '));
  const child = spawn('npm', args, {
    cwd: path.join('/workspace', directory), detached: true,
    env: { ...process.env, NODE_ENV: 'test', DB_PATH: '/tmp/unused-validation.sqlite' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false, spawnError = null, childCode = null, childSignal = null, closed = false, killTimer = null;
  const streams = [child.stdout, child.stderr];
  const streamsClosed = Promise.all(streams.map(stream => new Promise(resolve => {
    if (stream.closed) resolve();
    else stream.once('close', resolve);
  })));
  for (const stream of streams) stream.on('data', buffer => {
    output = (output + buffer.toString()).slice(-120000);
    if (!logfile.destroyed && !logfile.writableEnded) logfile.write(buffer);
  });
  const childClosed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      closed = true;
      childCode = code;
      childSignal = signal;
      resolve();
    });
  });
  const timer = setTimeout(() => {
    if (closed) return;
    timedOut = true;
    console.error('EXTERNAL_TIMEOUT ' + name + ' after ' + externalTimeoutSeconds + 's; sending SIGTERM to process group.');
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    killTimer = setTimeout(() => {
      if (closed) return;
      console.error('EXTERNAL_TIMEOUT ' + name + ' still active after 10s; sending SIGKILL to process group.');
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, 10000);
  }, externalTimeoutSeconds * 1000);
  await childClosed;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  await streamsClosed;
  await new Promise(resolve => logfile.end(resolve));
  const exitCode = timedOut || logError ? 1 : childCode ?? 1;
  const result = {
    name,
    command: 'cd ' + directory + ' && npm ' + args.join(' '),
    exitCode,
    childExitCode: childCode,
    signal: childSignal,
    timedOut,
    timeoutSeconds: externalTimeoutSeconds,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
  };
  if (spawnError) result.spawnError = spawnError.code || spawnError.message;
  if (logError) result.logWriteError = logError.code || logError.message;
  if (name === 'client-unit' && fs.existsSync('/evidence/client-jest.json')) {
    const j = JSON.parse(fs.readFileSync('/evidence/client-jest.json', 'utf8'));
    Object.assign(result, { tests: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests,
      suites: j.numTotalTestSuites, failedSuites: j.numFailedTestSuites });
  } else if (name.endsWith('-tests')) {
    for (const [field, label] of [['tests','tests'],['passed','pass'],['failed','fail'],['skipped','skipped']]) {
      const matches = [...output.matchAll(new RegExp('(?:#|\\u2139) ' + label + ' (\\d+)', 'g'))];
      if (matches.length) result[field] = Number(matches.at(-1)[1]);
    }
  } else if (name.endsWith('-browser')) {
    const match = output.match(/Evidence: ([^\r\n]+browser-evidence\.json)/);
    if (match && fs.existsSync(match[1])) {
      const evidence = JSON.parse(fs.readFileSync(match[1], 'utf8'));
      fs.copyFileSync(match[1], '/evidence/' + name + '.json');
      result.tests = evidence.checks.length;
      result.passed = evidence.checks.filter(check => check.passed).length;
      result.failed = result.tests - result.passed;
      result.skipped = 0;
      if (evidence.failure) result.failure = evidence.failure;
    }
  }
  if (exitCode) result.logTail = output.slice(-4000);
  console.log(JSON.stringify(result));
  return result;
}
(async () => {
  const results = [];
  for (const suite of groups[group]) results.push(await run(suite));
  fs.writeFileSync(`/evidence/${group}-results.json`, JSON.stringify(results, null, 2));
  process.exitCode = results.some(result => result.exitCode) ? 1 : 0;
})().catch(() => { console.error('Validation runner failed.'); process.exitCode = 1; });
