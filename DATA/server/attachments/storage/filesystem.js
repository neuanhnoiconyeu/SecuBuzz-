'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const {
    StorageError,
    STORAGE_KEY_PATTERN,
    generateStorageKey,
    assertStorageProvider,
} = require('./provider');

const STREAM_HIGH_WATER_MARK = 64 * 1024;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isWithin(root, candidate, pathFlavor = path) {
    const relative = pathFlavor.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathFlavor.sep}`) && !pathFlavor.isAbsolute(relative));
}

function rootDecision(root, repositoryRoot, pathFlavor = path) {
    if (typeof root !== 'string' || !pathFlavor.isAbsolute(root)) return 'ROOT_RELATIVE';
    if (typeof repositoryRoot !== 'string' || !pathFlavor.isAbsolute(repositoryRoot)) return 'ROOT_INVALID';
    const resolvedRoot = pathFlavor.resolve(root);
    const resolvedRepository = pathFlavor.resolve(repositoryRoot);
    return isWithin(resolvedRepository, resolvedRoot, pathFlavor) ? 'ROOT_IN_REPOSITORY' : null;
}

function asStorageError(error) {
    if (error instanceof StorageError) return error;
    if (error?.code === 'EEXIST') return new StorageError('STORAGE_EXISTS');
    if (error?.code === 'ENOENT') return new StorageError('STORAGE_MISSING');
    if (error?.code === 'LIMIT') return new StorageError('STORAGE_SIZE');
    return new StorageError('STORAGE_IO');
}

function createFilesystemProvider({ root, repositoryRoot, fsImpl = fs, pathFlavor = path } = {}) {
    if (rootDecision(root, repositoryRoot, pathFlavor)) throw new StorageError('STORAGE_IO');

    let realRoot;
    try {
        realRoot = fsImpl.realpathSync(root);
        const realRepositoryRoot = fsImpl.realpathSync(repositoryRoot);
        if (isWithin(realRepositoryRoot, realRoot, pathFlavor)) throw new StorageError('STORAGE_IO');
        const rootStat = fsImpl.statSync(realRoot);
        if (!rootStat.isDirectory()) throw new StorageError('STORAGE_IO');
        fsImpl.accessSync(realRoot, fs.constants.R_OK | fs.constants.W_OK);
        fsImpl.chmodSync(realRoot, 0o700);
    } catch (error) {
        // Initialization failures are configuration failures, including a root
        // that does not yet exist. Keep runtime missing-key semantics separate.
        throw error instanceof StorageError ? error : new StorageError('STORAGE_IO');
    }

    const resolve = key => {
        if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key) || WINDOWS_DEVICE_NAME.test(key) || /[. ]$/.test(key)) {
            throw new StorageError('STORAGE_KEY');
        }
        const result = pathFlavor.join(realRoot, key);
        if (pathFlavor.dirname(result) !== realRoot) throw new StorageError('STORAGE_KEY');
        return result;
    };

    const probe = pathFlavor.join(realRoot, `.probe-${generateStorageKey()}`);
    const probeLink = `${probe}.link`;
    let hardLinkSupported = false;
    try {
        fsImpl.writeFileSync(probe, 'probe', { flag: 'wx', mode: 0o600 });
        fsImpl.linkSync(probe, probeLink);
        hardLinkSupported = true;
    } catch {
        hardLinkSupported = false;
    } finally {
        for (const candidate of [probe, probeLink]) {
            try { fsImpl.unlinkSync(candidate); } catch { /* probe cleanup is best effort */ }
        }
    }

    function removeIfPresent(filename) {
        try { fsImpl.unlinkSync(filename); } catch { /* never expose filesystem details */ }
    }

    function assertNoExistingPath(filename) {
        try {
            fsImpl.lstatSync(filename);
            throw new StorageError('STORAGE_EXISTS');
        } catch (error) {
            if (error instanceof StorageError) throw error;
            if (error?.code !== 'ENOENT') throw asStorageError(error);
        }
    }

    async function write(key, readable, { maxBytes } = {}) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new StorageError('STORAGE_SIZE');
        if (!readable || typeof readable.pipe !== 'function') throw new StorageError('STORAGE_IO');
        const destination = resolve(key);
        const part = `${destination}.part`;
        let byteCount = 0;
        let published = false;
        const hash = createHash('sha256');
        const meter = new Transform({
            highWaterMark: STREAM_HIGH_WATER_MARK,
            transform(chunk, encoding, callback) {
                let bytes;
                try { bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); }
                catch { return callback(new StorageError('STORAGE_IO')); }
                byteCount += bytes.length;
                if (byteCount > maxBytes) return callback(Object.assign(new Error(), { code: 'LIMIT' }));
                hash.update(bytes);
                callback(null, bytes);
            },
        });

        try {
            assertNoExistingPath(destination);
            if (!hardLinkSupported) throw new StorageError('STORAGE_IO');
            await pipeline(readable, meter, fsImpl.createWriteStream(part, {
                flags: 'wx', mode: 0o600, highWaterMark: STREAM_HIGH_WATER_MARK,
            }));
            fsImpl.linkSync(part, destination);
            published = true;
            fsImpl.unlinkSync(part);
            published = false;
            return { byteCount, sha256: hash.digest('hex') };
        } catch (error) {
            if (published) removeIfPresent(destination);
            removeIfPresent(part);
            throw asStorageError(error);
        }
    }

    async function read(key) {
        const filename = resolve(key);
        let entry;
        try {
            entry = fsImpl.lstatSync(filename);
        } catch (error) {
            throw asStorageError(error);
        }
        if (!entry.isFile() || entry.isSymbolicLink()) throw new StorageError('STORAGE_IO');
        const stream = Readable.from((async function* readOpaqueBytes() {
            const source = fsImpl.createReadStream(filename, { highWaterMark: STREAM_HIGH_WATER_MARK });
            try {
                for await (const chunk of source) yield chunk;
            } catch (error) {
                throw asStorageError(error);
            }
        })(), { objectMode: false, highWaterMark: STREAM_HIGH_WATER_MARK });
        return { stream, byteCount: entry.size };
    }

    async function stat(key) {
        const filename = resolve(key);
        try {
            const entry = fsImpl.lstatSync(filename);
            if (!entry.isFile() || entry.isSymbolicLink()) throw new StorageError('STORAGE_IO');
            return entry.size;
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw asStorageError(error);
        }
    }

    async function exists(key) {
        return (await stat(key)) !== null;
    }

    async function remove(key) {
        try {
            fsImpl.unlinkSync(resolve(key));
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw asStorageError(error);
        }
    }

    async function usage() {
        let bytes = 0;
        let files = 0;
        for (const key of await listKeys()) {
            const size = await stat(key);
            if (size !== null) { bytes += size; files += 1; }
        }
        return { bytes, files };
    }

    async function sweepTemporary(olderThanMs) {
        if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new StorageError('STORAGE_IO');
        const cutoff = Date.now() - olderThanMs;
        let removed = 0;
        try {
            for (const name of fsImpl.readdirSync(realRoot)) {
                if (!name.endsWith('.part')) continue;
                const filename = pathFlavor.join(realRoot, name);
                if (fsImpl.lstatSync(filename).mtimeMs <= cutoff) {
                    fsImpl.unlinkSync(filename);
                    removed += 1;
                }
            }
            return removed;
        } catch (error) {
            throw asStorageError(error);
        }
    }

    async function listKeys() {
        try {
            return fsImpl.readdirSync(realRoot).filter(name => {
                if (!STORAGE_KEY_PATTERN.test(name)) return false;
                try {
                    const entry = fsImpl.lstatSync(pathFlavor.join(realRoot, name));
                    return entry.isFile() && !entry.isSymbolicLink();
                } catch (error) {
                    if (error?.code === 'ENOENT') return false;
                    throw error;
                }
            }).sort();
        } catch (error) {
            throw asStorageError(error);
        }
    }

    return Object.assign(assertStorageProvider({ write, read, stat, exists, delete: remove, usage, sweepTemporary, listKeys }), {
        resolve,
        hardLinkSupported,
    });
}

module.exports = { createFilesystemProvider, rootDecision, isWithin, STREAM_HIGH_WATER_MARK };
