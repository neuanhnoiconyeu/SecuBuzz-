'use strict';

// Isolated two-process DB-5C HTTP worker. It is usable only by the concurrency
// harness with a guarded temporary database and explicit test-only features.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { guardPath } = require('./groups');

function refuse(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

async function firstInputLine() {
    const lines = readline.createInterface({ input:process.stdin, crlfDelay:Infinity });
    return new Promise((resolve, reject) => {
        const onClose = () => reject(new Error('one request line is required'));
        lines.once('line', line => { lines.off('close', onClose); lines.close(); resolve(line); });
        lines.once('error', reject);
        lines.once('close', onClose);
    });
}

function requestInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['method','path','body','cookie','csrf'].includes(key)) ||
        !['POST','PATCH','DELETE'].includes(value.method) || typeof value.path !== 'string' ||
        !value.path.startsWith('/api/groups/') || value.path.includes('\\') ||
        typeof value.cookie !== 'string' || value.cookie.length > 8192 ||
        typeof value.csrf !== 'string' || value.csrf.length > 256) {
        throw new TypeError('worker request shape refused');
    }
    return value;
}

function waitForGo(directory, index) {
    const ready = path.join(directory, `ready-${index}`);
    const go = path.join(directory, 'go');
    fs.writeFileSync(ready, `${process.pid}\n`, { flag:'wx', mode:0o600 });
    return new Promise(resolve => {
        const poll = () => fs.existsSync(go) ? resolve() : setTimeout(poll, 1);
        poll();
    });
}

async function main() {
    if (process.env.SECUBUZZ_ISOLATED_GROUP_WORKER !== '1' || process.env.NODE_ENV !== 'test') {
        throw new Error('isolated test worker required');
    }
    const database = path.resolve(process.env.DB_PATH || '');
    const guardedDatabase = guardPath(database);
    if (!fs.statSync(guardedDatabase).isFile()) throw new Error('temporary fixture database required');
    const barrier = guardPath(process.env.SECUBUZZ_GROUP_WORKER_BARRIER || '');
    if (!fs.statSync(barrier).isDirectory()) throw new Error('temporary barrier directory required');
    const features = JSON.parse(process.env.SECUBUZZ_GROUP_WORKER_FEATURES || 'null');
    if (!features || typeof features !== 'object' || Array.isArray(features) || features.groupApi !== true ||
        !features.groups || typeof features.groups !== 'object') throw new Error('test feature configuration required');
    const origin = String(process.env.AUTH_ALLOWED_ORIGINS || '').split(',')[0].trim();
    if (!origin || !['http://localhost:3000','http://127.0.0.1:3000'].includes(origin)) throw new Error('loopback test origin required');

    const { startServer } = require('../../server/start');
    const limiter = Object.freeze({ consume:() => ({ allowed:true }) });
    let application;
    const rejectedPorts=[];
    for(let attempt=0;attempt<16;attempt++) {
        const candidate=await startServer({ env:process.env, features, limiter, log:() => {},
            messageOptions:{groupRecipientKeyVerifier:{async verifyEnvelope(){return {verified:true};}}} });
        const address=candidate.server.address();
        const port=address&&typeof address==='object'?address.port:null;
        if(!Number.isInteger(port)||port<1||port>65535) {
            await candidate.close();
            throw new Error('Worker server did not receive a valid TCP port.');
        }
        try {
            // Probe Node fetch's forbidden-port list before joining the process barrier.
            // A rejected candidate is closed before another OS-assigned ephemeral port is requested.
            await fetch(`http://127.0.0.1:${port}/__fixture_port_probe__`,{method:'HEAD',redirect:'manual'});
            application=candidate;
            break;
        } catch(error) {
            await candidate.close();
            if(error?.cause?.message!=='bad port'||String(process.env.PORT)!=='0')throw error;
            rejectedPorts.push(port);
        }
    }
    if(!application)throw new Error(`No Node-fetch-compatible worker port after 16 attempts; rejected ports: ${rejectedPorts.join(', ')}`);
    try {
        process.stdout.write(`READY ${application.server.address().port}\n`);
        const input = requestInput(JSON.parse(await firstInputLine()));
        process.stdin.pause();
        const index = Number(process.env.SECUBUZZ_GROUP_WORKER_INDEX);
        if (!Number.isInteger(index) || index < 0 || index > 5) throw new Error('worker index refused');
        await waitForGo(barrier, index);

        const headers = { Origin:origin, Accept:'application/json' };
        if (input.cookie) headers.Cookie = input.cookie;
        if (input.csrf) headers['X-CSRF-Token'] = input.csrf;
        if (Object.hasOwn(input, 'body')) headers['Content-Type'] = 'application/json';
        const response = await fetch(`http://127.0.0.1:${application.server.address().port}${input.path}`, {
            method:input.method, headers, ...(Object.hasOwn(input, 'body') ? { body:JSON.stringify(input.body) } : {}), redirect:'manual'
        });
        const text = await response.text();
        let body = null;
        if (text) {
            try { body = JSON.parse(text); } catch { body = { invalidJson:true }; }
        }
        require('./contract').assertGroupResponse(input.method, input.path, {status:response.status, body});
        await new Promise(resolve => process.stdout.write(`${JSON.stringify({ status:response.status, body })}\n`, resolve));
        application.server.closeAllConnections();
    } finally {
        await application.close();
    }
}

if (require.main === module) {
    main().then(() => process.exit(0), error => {
        const cause = error && error.cause;
        const detail = cause && (cause.code || cause.message)
            ? `${error.message} (${cause.code || cause.message})`
            : error && error.message ? error.message : 'unknown error';
        const message = `isolated group worker failed: ${detail}\n`;
        process.stderr.write(message, () => process.exit(1));
    });
}

module.exports = Object.freeze({ requestInput });
