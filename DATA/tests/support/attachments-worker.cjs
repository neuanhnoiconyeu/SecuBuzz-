'use strict';

// T-6B-40: disposable, cross-process attachment HTTP worker.
// It accepts only guarded temporary inputs and is enabled only by the quota harness.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { guardPath } = require('./groups');
const { guardStorageRoot } = require('./attachments');
const { createFilesystemProvider } = require('../../server/attachments/storage/filesystem');
const { StorageError } = require('../../server/attachments/storage/provider');

const NEVER = new Promise(() => {});
const SAFE_HEADERS = new Set(['content-type', 'x-forwarded-for', 'forwarded', 'x-real-ip', 'accept']);
const diagnostic = message => { if (process.env.SECUBUZZ_ATTACHMENT_WORKER_DIAGNOSTICS === '1') process.stderr.write('attachment worker phase=' + message + '\\n'); };

function validateCommand(value) {
    const allowed = new Set(['method', 'path', 'headers', 'bodyFile', 'cookie', 'csrf', 'command', 'holdAfterBytes']);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !allowed.has(key)) ||
        !['GET', 'POST', 'DELETE'].includes(value.method) ||
        typeof value.path !== 'string' ||
        (!value.path.startsWith('/api/attachments') && !value.path.startsWith('/api/files/')) ||
        value.path.includes('\\\\') || value.path.includes('\\0') ||
        (value.headers !== undefined && (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) ||
            Object.keys(value.headers).some(key => !SAFE_HEADERS.has(key.toLowerCase()) ||
                typeof value.headers[key] !== 'string' || value.headers[key].length > 4096))) ||
        (value.cookie !== undefined && (typeof value.cookie !== 'string' || value.cookie.length > 8192)) ||
        (value.csrf !== undefined && (typeof value.csrf !== 'string' || value.csrf.length > 256)) ||
        (value.bodyFile !== undefined && typeof value.bodyFile !== 'string') ||
        (value.command !== undefined && value.command !== 'hold-upload') ||
        (value.command === 'hold-upload' && (value.method !== 'POST' || !Number.isSafeInteger(value.holdAfterBytes) ||
            value.holdAfterBytes < 5))) {
        throw new TypeError('attachment worker request shape refused');
    }
    return value;
}

function waitForMarker(directory, name) {
    const target = path.join(directory, name);
    if (path.dirname(target) !== directory) throw new TypeError('attachment worker marker refused');
    return new Promise(resolve => {
        const poll = () => {
            if (fs.existsSync(target)) { fs.unlinkSync(target); resolve(); }
            else setTimeout(poll, 2);
        };
        poll();
    });
}

function bodyStream(file, holdAfterBytes, sequence) {
    if (holdAfterBytes === undefined) return fs.createReadStream(file);
    return require('node:stream').Readable.from((async function* () {
        let sent = 0;
        for await (const chunk of fs.createReadStream(file)) {
            const remaining = holdAfterBytes - sent;
            if (remaining <= 0) break;
            const part = chunk.subarray(0, Math.min(chunk.length, remaining));
            if (part.length) { sent += part.length; yield part; }
            if (sent >= holdAfterBytes) {
                process.stdout.write(JSON.stringify({ event: 'upload-in-flight', sequence: sequence }) + '\n');
                await NEVER;
            }
        }
    })());
}

async function main() {
    if (process.env.SECUBUZZ_ISOLATED_ATTACHMENT_WORKER !== '1' ||
        process.env.NODE_ENV !== 'test' ||
        process.env.SECUBUZZ_DOCKER_VALIDATION === 'true') {
        throw new Error('isolated host test worker required');
    }
    diagnostic('isolation-verified');
    const database = guardPath(path.resolve(process.env.DB_PATH || ''));
    if (!fs.statSync(database).isFile()) throw new Error('temporary fixture database required');
    const storageRoot = guardStorageRoot(process.env.SECUBUZZ_ATTACHMENT_WORKER_STORAGE || '');
    if (!fs.statSync(storageRoot).isDirectory()) throw new Error('temporary storage directory required');
    const barrier = guardPath(path.resolve(process.env.SECUBUZZ_ATTACHMENT_WORKER_BARRIER || ''));
    if (!fs.statSync(barrier).isDirectory()) throw new Error('temporary barrier directory required');
    diagnostic('temporary-paths-verified');
    const features = JSON.parse(process.env.SECUBUZZ_ATTACHMENT_WORKER_FEATURES || 'null');
    if (!features || typeof features !== 'object' || Array.isArray(features) ||
        features.attachmentApi !== true || !features.attachments ||
        features.attachments.storageDir !== storageRoot) throw new Error('test feature configuration required');
    const index = Number(process.env.SECUBUZZ_ATTACHMENT_WORKER_INDEX);
    const batch = Number(process.env.SECUBUZZ_ATTACHMENT_WORKER_BATCH || '0');
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('worker index refused');
    if (!Number.isInteger(batch) || batch < 0 || batch > 19) throw new Error('worker batch refused');
    const origin = String(process.env.AUTH_ALLOWED_ORIGINS || '').split(',')[0].trim();
    if (!origin || !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)) {
        throw new Error('loopback test origin required');
    }

    diagnostic('features-verified');
    const { startServer } = require('../../server/start');
    const provider = createFilesystemProvider({ root: storageRoot, repositoryRoot: path.resolve(__dirname, '../..') });
    diagnostic('provider-created');
    const storage = process.env.SECUBUZZ_ATTACHMENT_WORKER_FAIL_STORAGE === '1'
        ? Object.freeze({ ...provider, write: async () => { throw new StorageError('STORAGE_IO'); } })
        : provider;
    let application;
    const rejected = [];
    for (let attempt = 0; attempt < 16; attempt++) {
        const openLimiter = process.env.SECUBUZZ_ATTACHMENT_WORKER_OPEN_LIMITER === '1' ? { consume: () => ({ allowed: true }) } : undefined;
        const testNow = Number(process.env.SECUBUZZ_ATTACHMENT_WORKER_NOW);
        if (!Number.isSafeInteger(testNow) || testNow < 0) throw new Error('synthetic worker clock required');
        diagnostic('starting-server');
        const candidate = await startServer({ env: process.env, features: features, storage: storage, now:() => testNow, ...(openLimiter ? { limiter: openLimiter } : {}), log: () => {} });
        diagnostic('server-started');
        const address = candidate.server.address();
        const port = address && typeof address === 'object' ? address.port : null;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            await candidate.close();
            throw new Error('worker server did not receive a valid TCP port');
        }
        try {
            diagnostic('port-probe');
            await fetch('http://127.0.0.1:' + port + '/__fixture_port_probe__', { method: 'HEAD', redirect: 'manual' });
            application = candidate;
            diagnostic('ready');
            break;
        } catch (error) {
            await candidate.close();
            if (error && error.cause && error.cause.message === 'bad port' && String(process.env.PORT) === '0') {
                rejected.push(port);
                continue;
            }
            throw error;
        }
    }
    if (!application) throw new Error('no Fetch-compatible worker port after 16 attempts: ' + rejected.join(','));


    process.stdout.write('READY ' + application.server.address().port + '\n');

    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let sequence = 0;
    let nextOutput = 0;
    const completed = new Map();
    const tasks = new Set();
    let stopping = false, shutdownPromise = null;
    function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        stopping = true;
        input.close();
        shutdownPromise = (async () => {
            await Promise.race([Promise.allSettled([...tasks]), new Promise(resolve => setTimeout(resolve, 5000))]);
            application.server.closeAllConnections();
            await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 2000))]);
            process.exit(0);
        })();
        return shutdownPromise;
    }
    process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    function writeResult(order, value) {
        completed.set(order, value);
        while (completed.has(nextOutput)) {
            const item = completed.get(nextOutput);
            completed.delete(nextOutput++);
            process.stdout.write(JSON.stringify(item) + '\n');
        }
    }
    input.on('line', line => {
        const order = sequence++;
        const task = (async () => {
            const command = validateCommand(JSON.parse(line));
            let bodyFile = null;
            if (command.bodyFile !== undefined) {
                bodyFile = guardPath(path.resolve(command.bodyFile));
                if (!fs.statSync(bodyFile).isFile()) throw new Error('temporary request body file required');
            }
            const readyName = 'ready-' + batch + '-' + index + '-' + order;
            const goName = 'go-' + batch + '-' + index + '-' + order;
            fs.writeFileSync(path.join(barrier, readyName), process.pid + '\n', { flag: 'wx', mode: 0o600 });
            process.stdout.write('ARMED ' + order + '\n');
            fs.unlinkSync(path.join(barrier, readyName));
            await waitForMarker(barrier, goName);
            const headers = { Origin: origin, Accept: 'application/json', ...(command.headers || {}) };
            if (command.cookie) headers.Cookie = command.cookie;
            if (command.csrf) headers['X-CSRF-Token'] = command.csrf;
            const response = await fetch('http://127.0.0.1:' + application.server.address().port + command.path, {
                method: command.method,
                headers: headers,
                ...(bodyFile ? { body: bodyStream(bodyFile, command.command === 'hold-upload' ? command.holdAfterBytes : undefined, order), duplex: 'half' } : {}),
                redirect: 'manual'
            });
            const text = await response.text();
            let parsed = null;
            if (text) { try { parsed = JSON.parse(text); } catch { parsed = { invalidJson: true }; } }
            writeResult(order, { status: response.status, body: parsed });
        })().catch(error => {
            const cause = error && error.cause;
            const detail = cause && (cause.code || cause.message)
                ? error.message + ' (' + (cause.code || cause.message) + ')'
                : error && error.message ? error.message : 'unknown error';
            writeResult(order, { workerError: detail });
        });
        tasks.add(task);
        task.finally(() => tasks.delete(task));
    });
    input.on('close', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    input.on('error', error => { process.stderr.write('attachment worker input failed: ' + error.message + '\n'); process.exitCode = 1; });
}

if (require.main === module) main().catch(error => {
    process.stderr.write('isolated attachment worker failed: ' + error.message + '\n');
    process.exit(1);
});

module.exports = Object.freeze({ validateCommand });
