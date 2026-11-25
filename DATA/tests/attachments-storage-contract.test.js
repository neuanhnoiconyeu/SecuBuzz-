'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createFilesystemProvider, rootDecision, STREAM_HIGH_WATER_MARK } = require('../server/attachments/storage/filesystem');
const { generateStorageKey, STORAGE_KEY_PATTERN, StorageError, assertStorageProvider, OPERATIONS } = require('../server/attachments/storage/provider');
const { providers, assertRegistryComplete } = require('./support/storage-providers');
const { storageRoot, guardStorageRoot, frame, upload, snapshotStorage, extendSnapshot } = require('./support/attachments');
const { createRandom } = require('./support/random');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const MEMORY_PROBE_CHUNK_BYTES = 64 * 1024;
const MEMORY_PROBE_SIZES = [4 * 1024 * 1024, 50 * 1024 * 1024];
// Fixed after the Windows 4/50 MiB calibration with a reusable source chunk:
// the larger stream's sampled RSS delta was 15.1 MiB. A 32 MiB cap detects
// full-payload buffering while allowing runtime and allocator overhead.
const MEMORY_PROBE_MAX_DELTA_BYTES = 32 * 1024 * 1024;
const hostileFixed = [
    '../outside', '..\\outside', '/absolute/path', '\\\\server\\share', 'C:\\temp\\key', 'c:/temp/key',
    'name:stream', 'name:$DATA', 'CON', 'con.txt', 'PRN', 'aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9',
    'name.', 'name ', 'LONGFI~1.TXT', '%2e%2e%2fsecret', '%252e%252e%252f', 'a/b', 'a\\b', '', '.', '..',
];

function safeError(error, root) {
    assert.ok(error instanceof StorageError);
    assert.ok(['STORAGE_KEY', 'STORAGE_EXISTS', 'STORAGE_SIZE', 'STORAGE_MISSING', 'STORAGE_IO'].includes(error.code));
    assert.equal(error.message, '');
    for (const key of ['path', 'root', 'cause']) assert.equal(key in error, false);
    const exposed = `${error.message} ${JSON.stringify(error)}`;
    assert.equal(exposed.includes(root), false);
    assert.equal(/[A-Za-z]:\\[^\s"']+/.test(exposed), false);
    assert.equal(/(?:^|[\s"'])\/(?:tmp|var|home)\//.test(exposed), false);
}

function readAll(stream) {
    return (async () => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); })();
}

function chunksOf(bytes, random) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length;) {
        const size = random.int(1, Math.min(65536, bytes.length - offset));
        chunks.push(bytes.subarray(offset, offset + size));
        offset += size;
    }
    return chunks;
}

function streamFailingAt(bytes, stopAt, error, random) {
    let offset = 0;
    let scheduled = false;
    return new Readable({
        read() {
            if (scheduled) return;
            if (offset >= stopAt) {
                scheduled = true;
                setImmediate(() => this.destroy(error));
                return;
            }
            const remaining = Math.min(stopAt - offset, bytes.length - offset);
            const size = random.int(1, Math.min(65536, remaining));
            this.push(bytes.subarray(offset, offset + size));
            offset += size;
            if (offset >= stopAt) {
                scheduled = true;
                setImmediate(() => this.destroy(error));
            }
        },
    });
}

function repeatedByteStream(totalBytes, byteValue) {
    let remaining = totalBytes;
    const reusableChunk = Buffer.alloc(MEMORY_PROBE_CHUNK_BYTES, byteValue);
    return new Readable({
        read() {
            if (remaining === 0) { this.push(null); return; }
            const size = Math.min(MEMORY_PROBE_CHUNK_BYTES, remaining);
            this.push(reusableChunk.subarray(0, size));
            remaining -= size;
        },
    });
}

function repeatedByteSha256(totalBytes, byteValue) {
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(MEMORY_PROBE_CHUNK_BYTES, byteValue);
    let remaining = totalBytes;
    while (remaining > 0) {
        const size = Math.min(chunk.length, remaining);
        hash.update(chunk.subarray(0, size));
        remaining -= size;
    }
    return hash.digest('hex');
}

function rootProvider(t, options = {}) {
    const root = storageRoot(t);
    return { root, provider: createFilesystemProvider({ root, repositoryRoot, ...options }) };
}

test('Storage_Key has 192 random bits, matches the closed format and 10000 draws do not collide', () => {
    const first = generateStorageKey();
    assert.match(first, STORAGE_KEY_PATTERN);
    assert.equal(Buffer.from(first, 'hex').length, 24);
    const keys = new Set(Array.from({ length: 10000 }, generateStorageKey));
    assert.equal(keys.size, 10000);
});

test('Storage_Provider rejects each missing operation and StorageError exposes only closed codes', t => {
    assert.doesNotThrow(assertRegistryComplete);
    const registered = providers(t);
    assert.ok(registered.length > 0);
    for (const { provider } of registered) assert.doesNotThrow(() => assertStorageProvider(provider));
    for (const missing of OPERATIONS) {
        const candidate = Object.fromEntries(OPERATIONS.filter(operation => operation !== missing).map(operation => [operation, () => {}]));
        assert.throws(() => assertStorageProvider(candidate), TypeError, missing);
    }
    for (const code of ['STORAGE_KEY', 'STORAGE_EXISTS', 'STORAGE_SIZE', 'STORAGE_MISSING', 'STORAGE_IO']) {
        const error = new StorageError(code);
        assert.equal(error.code, code);
        assert.equal(error.message, '');
        for (const key of ['path', 'root', 'cause']) assert.equal(key in error, false);
    }
    assert.throws(() => new StorageError('SECRET'), TypeError);
});

test('T-6B-12 root containment, Docker path flavours, writable checks and link aliases fail closed', t => {
    const root = storageRoot(t);
    assert.equal(rootDecision('/var/lib/secubuzz/attachments', '/workspace', path.posix), null);
    assert.equal(rootDecision('/workspace', '/workspace', path.posix), 'ROOT_IN_REPOSITORY');
    assert.equal(rootDecision('/workspace/private', '/workspace', path.posix), 'ROOT_IN_REPOSITORY');
    assert.equal(rootDecision('/workspace/tmp/../../workspace/data', '/workspace', path.posix), 'ROOT_IN_REPOSITORY');
    assert.equal(rootDecision('C:\\var\\secubuzz\\attachments', 'C:\\workspace', path.win32), null);
    assert.equal(rootDecision('C:\\workspace\\data', 'C:\\workspace', path.win32), 'ROOT_IN_REPOSITORY');
    assert.equal(rootDecision('C:\\workspace\\tmp\\..\\data', 'C:\\workspace', path.win32), 'ROOT_IN_REPOSITORY');

    assert.throws(() => createFilesystemProvider({ root: 'relative', repositoryRoot }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
    assert.throws(() => createFilesystemProvider({ root: path.join(root, 'missing'), repositoryRoot }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
    const file = path.join(root, 'not-a-directory'); fs.writeFileSync(file, 'x');
    assert.throws(() => createFilesystemProvider({ root: file, repositoryRoot }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
    assert.throws(() => createFilesystemProvider({ root: repositoryRoot, repositoryRoot }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
    assert.throws(() => createFilesystemProvider({ root: path.resolve(repositoryRoot, 'DATA'), repositoryRoot }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });

    const deniedFs = new Proxy(fs, { get(target, property) {
        if (property === 'accessSync') return () => { throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' }); };
        return Reflect.get(target, property, target);
    } });
    assert.throws(() => createFilesystemProvider({ root, repositoryRoot, fsImpl: deniedFs }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });

    const alias = path.join(root, 'repository-link');
    try { fs.symlinkSync(repositoryRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        assert.ok(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code), `unexpected link creation error: ${error.code}`);
        const linkedFs = new Proxy(fs, { get(target, property) {
            if (property === 'realpathSync') return candidate => candidate === alias ? fs.realpathSync(repositoryRoot) : fs.realpathSync(candidate);
            return Reflect.get(target, property, target);
        } });
        assert.throws(() => createFilesystemProvider({ root: alias, repositoryRoot, fsImpl: linkedFs }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
    }
    if (fs.existsSync(alias)) assert.throws(() => createFilesystemProvider({ root: alias, repositoryRoot }), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
});

test('T-6B-12 validates 100 random keys per class and the full fixed hostile-key corpus', t => {
    for (const { root, provider } of providers(t)) {
        const random = createRandom(812015);
        const check = key => {
            try {
                const resolved = provider.resolve(key);
                assert.equal(path.dirname(resolved), fs.realpathSync(root));
            } catch (error) {
                safeError(error, root);
                assert.equal(error.code, 'STORAGE_KEY');
            }
        };
        for (const key of hostileFixed) check(key);
        const unicode = Array.from('é中🙂🧪');
        for (let run = 0; run < 100; run++) check(random.string(unicode, 0, 200));
        for (let run = 0; run < 100; run++) check(random.string('abcdefghijklmnopqrstuvwxyz0123456789', 0, 200));
        const classes = [
            index => `../${random.string('abc012', 0, 40)}-${index}`,
            index => `\\\\host\\share\\${index}`,
            index => `C:\\temp\\${index}`,
            index => `C:${random.string('abc012', 0, 40)}:${index}`,
            index => `${['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'][index % 8]}-${index}`,
            index => `${random.string('abcdef0123', 1, 40)}-${index}.`,
            index => `${random.string('abcdef0123', 1, 40)}-${index} `,
            index => `LONGFI~${index % 9 + 1}.TXT`,
            index => `%2e%2e%2fsecret-${index}`,
            index => `segment-${index}/child`,
            index => `segment-${index}\\child`,
        ];
        for (const generate of classes) for (let run = 0; run < 100; run++) check(generate(run));
    }
});

test('T-6B-13 streams opaque bytes through exclusive .part and hard-link no-replace finalization', async t => {
    const { root, provider } = rootProvider(t);
    const random = createRandom(813013);
    const content = random.bytes(131071);
    const key = generateStorageKey();
    assert.equal(provider.hardLinkSupported, true, `hard-link probe failed on ${process.platform}`);
    const expectedHash = createHash('sha256').update(content).digest('hex');
    assert.deepEqual(await provider.write(key, Readable.from(chunksOf(content, random)), { maxBytes: content.length }), {
        byteCount: content.length, sha256: expectedHash,
    });
    const finalPath = provider.resolve(key);
    assert.deepEqual(await readAll((await provider.read(key)).stream), content);
    assert.equal(fs.existsSync(`${finalPath}.part`), false);
    assert.equal(fs.statSync(finalPath).nlink, 1);
    const before = fs.readFileSync(finalPath);
    await assert.rejects(provider.write(key, Readable.from([Buffer.from('replacement')]), { maxBytes: 100 }), error => {
        safeError(error, root); return error.code === 'STORAGE_EXISTS';
    });
    assert.deepEqual(fs.readFileSync(finalPath), before);
    assert.deepEqual(fs.readdirSync(root), [key]);
});

test('T-6B-13 failed writes clean the partial file and preserve final objects', async t => {
    const { root, provider } = rootProvider(t);
    const key = generateStorageKey();
    let calls = 0;
    const failingLinkFs = new Proxy(fs, { get(target, property) {
        if (property === 'linkSync') return (from, to) => {
            calls += 1;
            if (calls === 2) throw Object.assign(new Error('private link detail'), { code: 'EPERM' });
            return fs.linkSync(from, to);
        };
        return Reflect.get(target, property, target);
    } });
    const failingProvider = createFilesystemProvider({ root, repositoryRoot, fsImpl: failingLinkFs });
    assert.equal(failingProvider.hardLinkSupported, true);
    await assert.rejects(failingProvider.write(key, Readable.from([Buffer.from('content')]), { maxBytes: 100 }), error => {
        safeError(error, root); return error.code === 'STORAGE_IO';
    });
    assert.deepEqual(fs.readdirSync(root), []);

    const alreadyThere = generateStorageKey();
    const original = Buffer.from('original');
    const digest = createHash('sha256').update(original).digest('hex');
    assert.deepEqual(await provider.write(alreadyThere, Readable.from([original]), { maxBytes: 100 }), { byteCount: original.length, sha256: digest });
    await assert.rejects(provider.write(alreadyThere, Readable.from([Buffer.from('other')]), { maxBytes: 100 }), error => error.code === 'STORAGE_EXISTS');
    assert.deepEqual(fs.readdirSync(root).sort(), [alreadyThere]);
    assert.deepEqual(fs.readFileSync(provider.resolve(alreadyThere)), original);
});

test('T-6B-14 implements read/stat/exists/delete/usage/sweep/list with sanitized failures', async t => {
    const { root, provider } = rootProvider(t);
    const key = generateStorageKey();
    const body = Buffer.from('opaque bytes');
    const sha256 = createHash('sha256').update(body).digest('hex');
    assert.deepEqual(await provider.write(key, Readable.from([body]), { maxBytes: 100 }), { byteCount: body.length, sha256 });
    assert.deepEqual(await provider.read(key).then(async result => ({ byteCount: result.byteCount, bytes: await readAll(result.stream) })), { byteCount: body.length, bytes: body });
    assert.equal(await provider.stat(key), body.length);
    assert.equal(await provider.exists(key), true);
    assert.deepEqual(await provider.usage(), { bytes: body.length, files: 1 });
    assert.deepEqual(await provider.listKeys(), [key]);
    assert.equal(await provider.stat(generateStorageKey()), null);
    assert.equal(await provider.exists(generateStorageKey()), false);
    assert.equal(await provider.delete(generateStorageKey()), false);
    await assert.rejects(provider.read(generateStorageKey()), error => { safeError(error, root); return error.code === 'STORAGE_MISSING'; });

    const oldPart = path.join(root, 'orphan.part');
    const recentPart = path.join(root, 'recent.part');
    fs.writeFileSync(oldPart, 'old');fs.writeFileSync(recentPart, 'recent');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(oldPart, old, old);
    assert.equal(await provider.sweepTemporary(60000), 1);
    assert.equal(fs.existsSync(oldPart), false);
    assert.equal(fs.existsSync(recentPart), true);
    assert.deepEqual(await provider.listKeys(), [key]);
    assert.equal(await provider.delete(key), true);
    assert.equal(await provider.delete(key), false);

    const failingReadFs = new Proxy(fs, { get(target, property) {
        if (property === 'createReadStream') return () => new Readable({ read() {
            this.destroy(Object.assign(new Error('private read path'), { code: 'EACCES' }));
        } });
        return Reflect.get(target, property, target);
    } });
    const failingReader = createFilesystemProvider({ root, repositoryRoot, fsImpl: failingReadFs });
    const readKey = generateStorageKey();
    await provider.write(readKey, Readable.from([body]), { maxBytes: 100 });
    await assert.rejects(readAll((await failingReader.read(readKey)).stream), error => {
        safeError(error, root); return error.code === 'STORAGE_IO';
    });
});

test('T-6B-15 branches on platform for directory/file permissions without skips', async t => {
    const { root, provider } = rootProvider(t);
    const key = generateStorageKey();
    const bytes = Buffer.from('mode check');
    await provider.write(key, Readable.from([bytes]), { maxBytes: 100 });
    if (process.platform === 'win32') {
        assert.doesNotThrow(() => fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK));
        assert.doesNotThrow(() => fs.accessSync(provider.resolve(key), fs.constants.R_OK | fs.constants.W_OK));
    } else {
        assert.equal(fs.statSync(root).mode & 0o777, 0o700);
        assert.equal(fs.statSync(provider.resolve(key)).mode & 0o777, 0o600);
    }
});

test('T-6B-15 branches on platform and refuses symlinks at a storage key', async t => {
    const { root, provider } = rootProvider(t);
    const targetRoot = storageRoot(t);
    const outside = path.join(targetRoot, 'outside');fs.writeFileSync(outside, 'do not read');
    const key = generateStorageKey();
    const link = provider.resolve(key);
    let linkCreated = false;
    try { fs.symlinkSync(outside, link, 'file'); linkCreated = true; }
    catch (error) { assert.ok(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)); }
    const simulatedFs = new Proxy(fs, { get(target, property) {
        if (property === 'lstatSync' && !linkCreated) return filename => filename === link
            ? { isFile: () => false, isSymbolicLink: () => true }
            : fs.lstatSync(filename);
        return Reflect.get(target, property, target);
    } });
    const testedProvider = linkCreated ? provider : createFilesystemProvider({ root, repositoryRoot, fsImpl: simulatedFs });
    await assert.rejects(testedProvider.read(key), error => { safeError(error, root); return error.code === 'STORAGE_IO'; });
    await assert.rejects(testedProvider.write(key, Readable.from([Buffer.from('replacement')]), { maxBytes: 100 }), error => {
        safeError(error, root); return error.code === 'STORAGE_EXISTS';
    });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not read');
});

test('T-6B-15 branches on platform for hard-link finalization and injected link errors', async t => {
    const { root, provider } = rootProvider(t);
    assert.equal(provider.hardLinkSupported, true, `hard-link probe failed on ${process.platform}`);
    const key = generateStorageKey();
    await provider.write(key, Readable.from([Buffer.from('linked')]), { maxBytes: 100 });
    assert.equal(fs.statSync(provider.resolve(key)).nlink, 1);
    assert.equal(fs.existsSync(`${provider.resolve(key)}.part`), false);

    let links = 0;
    const injectedFs = new Proxy(fs, { get(target, property) {
        if (property === 'linkSync') return (from, to) => {
            links += 1;
            if (links === 2) throw Object.assign(new Error('private link failure'), { code: process.platform === 'win32' ? 'EXDEV' : 'EPERM' });
            return fs.linkSync(from, to);
        };
        return Reflect.get(target, property, target);
    } });
    const failing = createFilesystemProvider({ root, repositoryRoot, fsImpl: injectedFs });
    const failedKey = generateStorageKey();
    await assert.rejects(failing.write(failedKey, Readable.from([Buffer.from('partial')]), { maxBytes: 100 }), error => {
        safeError(error, root); return error.code === 'STORAGE_IO';
    });
    assert.equal(fs.existsSync(failing.resolve(failedKey)), false);
    assert.equal(fs.existsSync(`${failing.resolve(failedKey)}.part`), false);
});

test('T-6B-15 shared provider corpus: 100 random keys per class and 100 deterministic streams', async t => {
    const random = createRandom(815015);
    const cases = ['success', 'abort', 'io-error', 'size', 'collision'];
    for (const { root, provider } of providers(t)) for (let run = 0; run < 100; run++) {
        const draw = random.fork(`stream-${run}`);
        const kind = cases[run % cases.length];
        const key = generateStorageKey();
        const before = new Set(await provider.listKeys());
        if (kind === 'success') {
            const body = draw.bytes(draw.int(0, 3 * 1024 * 1024));
            const expected = createHash('sha256').update(body).digest('hex');
            const result = await provider.write(key, Readable.from(chunksOf(body, draw)), { maxBytes: Math.max(1, body.length) });
            assert.deepEqual(result, { byteCount: body.length, sha256: expected });
            const readBack = await provider.read(key);
            const content = await readAll(readBack.stream);
            assert.equal(readBack.byteCount, body.length);assert.deepEqual(content, body);
            assert.equal((await provider.stat(key)), body.length);
        } else if (kind === 'collision') {
            const original = draw.bytes(draw.int(0, 2048));
            const originalHash = createHash('sha256').update(original).digest('hex');
            await provider.write(key, Readable.from([original]), { maxBytes: Math.max(1, original.length) });
            await assert.rejects(provider.write(key, Readable.from([Buffer.from('replacement')]), { maxBytes: 100 }), error => {
                safeError(error, root); return error.code === 'STORAGE_EXISTS';
            });
            assert.equal(createHash('sha256').update(fs.readFileSync(provider.resolve(key))).digest('hex'), originalHash);
        } else {
            const failure = kind === 'abort'
                ? Object.assign(new Error('synthetic abort'), { name: 'AbortError' })
                : Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' });
            const body = draw.bytes(draw.int(0, 3 * 1024 * 1024));
            const source = streamFailingAt(body, draw.int(0, body.length), failure, draw);
            if (kind === 'size') {
                const body = draw.bytes(8193);
                await assert.rejects(provider.write(key, Readable.from(chunksOf(body, draw)), { maxBytes: 8192 }), error => {
                    safeError(error, root); return error.code === 'STORAGE_SIZE';
                });
            } else {
                await assert.rejects(provider.write(key, source, { maxBytes: body.length + 1 }), error => {
                    safeError(error, root); return error.code === 'STORAGE_IO';
                });
            }
        }
        const after = new Set(await provider.listKeys());
        const allowed = kind === 'success' || kind === 'collision' ? key : null;
        if (allowed) assert.deepEqual([...after].sort(), [...new Set([...before, allowed])].sort(), `seed=815015 run=${run} kind=${kind}`);
        else assert.deepEqual([...after].sort(), [...before].sort());
        assert.equal(fs.readdirSync(root).some(name => name.endsWith('.part')), false);
    }
});

test('T-6B-17 samples memory while streaming 4 MiB and 50 MiB through write and read', async t => {
    const { root, provider } = rootProvider(t);
    const measurements = [];
    for (const byteSize of MEMORY_PROBE_SIZES) {
        const key = generateStorageKey();
        const expectedSha256 = repeatedByteSha256(byteSize, 0x5a);
        const initialMemory = process.memoryUsage();
        const initialRss = initialMemory.rss;
        let peakArrayBuffers = initialMemory.arrayBuffers;
        let peakRss = initialRss;
        const sample = () => {
            const memory = process.memoryUsage();
            peakRss = Math.max(peakRss, memory.rss);
            peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
        };
        const sampler = setInterval(sample, 5);
        try {
            const written = await provider.write(key, repeatedByteStream(byteSize, 0x5a), { maxBytes: byteSize });
            assert.deepEqual(written, { byteCount: byteSize, sha256: expectedSha256 });
            const stored = await provider.read(key);
            assert.equal(stored.byteCount, byteSize);
            const hash = createHash('sha256');
            let bytesRead = 0;
            for await (const chunk of stored.stream) { bytesRead += chunk.length; hash.update(chunk); }
            assert.equal(bytesRead, byteSize);
            assert.equal(hash.digest('hex'), expectedSha256);
        } finally {
            clearInterval(sampler);
            sample();
            await provider.delete(key);
        }
        measurements.push({ byteSize, initialRss, peakRss, peakRssDelta: peakRss - initialRss,
            initialArrayBuffers: initialMemory.arrayBuffers, peakArrayBuffers,
            peakArrayBuffersDelta: peakArrayBuffers - initialMemory.arrayBuffers });
    }
    for (const measurement of measurements) {
        assert.ok(measurement.peakRssDelta <= MEMORY_PROBE_MAX_DELTA_BYTES,
            `sampled RSS delta ${measurement.peakRssDelta} exceeds ${MEMORY_PROBE_MAX_DELTA_BYTES} bytes for ${measurement.byteSize} bytes`);
        assert.ok(measurement.peakArrayBuffersDelta <= MEMORY_PROBE_MAX_DELTA_BYTES,
            `sampled ArrayBuffers delta ${measurement.peakArrayBuffersDelta} exceeds ${MEMORY_PROBE_MAX_DELTA_BYTES} bytes for ${measurement.byteSize} bytes`);
    }
    t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version, hardLinkSupported: provider.hardLinkSupported, measurements }));
});

test('attachment helpers frame Browser uploads, guard temporary roots and extend snapshots', async t => {
    const root = storageRoot(t);assert.equal(guardStorageRoot(root), fs.realpathSync(root));
    assert.throws(() => guardStorageRoot(repositoryRoot));
    const key = generateStorageKey(), payload = Buffer.from('opaque');fs.writeFileSync(path.join(root, key), payload);
    const header = { conversationId: 'c1', byteSize: payload.length, encryptedMetadata: 'm', algorithm: 'test', formatVersion: '1' };
    let request;
    const browser = { request: async (...args) => { request = args; return { status: 202 }; } };
    assert.deepEqual(await upload(browser, header, payload, 'csrf-token'), { status: 202 });
    assert.equal(request[0], '/api/attachments');assert.equal(request[1].method, 'POST');
    assert.equal(request[1].headers['X-CSRF-Token'], 'csrf-token');assert.deepEqual(request[1].rawBody, frame(header, payload));
    assert.deepEqual(snapshotStorage(root), [{ name: key, size: payload.length }]);
    assert.deepEqual(extendSnapshot({ tables: { groups: 'hash' } }, root), { tables: { groups: 'hash' }, storage: [{ name: key, size: payload.length }] });
});
