const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { AuthError } = require('../auth/errors');

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp']);

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function createAvatarStorage({ db, options = {} }) {
  let root = null;
  function ensureDir() {
    if (root) return root;
    const base = options.avatarDirectory
      || process.env.AVATAR_STORAGE_DIR
      || (db.name && db.name !== ':memory:' ? path.join(path.dirname(path.resolve(db.name)), 'avatars')
        : path.join(os.tmpdir(), `secubuzz-avatars-${process.pid}`));
    const resolved = path.resolve(base);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    root = resolved;
    return root;
  }

  function resolveKey(storageKey) {
    if (typeof storageKey !== 'string' || !/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(storageKey)) {
      throw new AuthError('NOT_FOUND', 404);
    }
    const dir = ensureDir();
    const target = path.resolve(dir, storageKey);
    if (path.dirname(target) !== dir) throw new AuthError('NOT_FOUND', 404);
    return target;
  }

  async function readStream(request) {
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new AuthError('UNSUPPORTED_MEDIA_TYPE', 415);
    const declared = Number(request.headers['content-length'] || 0);
    if (declared > MAX_AVATAR_BYTES) throw new AuthError('PAYLOAD_TOO_LARGE', 413);
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_AVATAR_BYTES) throw new AuthError('PAYLOAD_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    if (total === 0) throw new AuthError('VALIDATION_ERROR', 400, ['avatar']);
    const buffer = Buffer.concat(chunks, total);
    const mimeType = detectImageMime(buffer);
    if (!mimeType) throw new AuthError('VALIDATION_ERROR', 400, ['avatar']);
    if (contentType !== 'application/octet-stream' && contentType !== mimeType) {
      throw new AuthError('VALIDATION_ERROR', 400, ['avatar']);
    }
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    const storageKey = `${randomUUID()}.${ext}`;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const target = resolveKey(storageKey);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    return { storageKey, mimeType, byteSize: buffer.length, sha256 };
  }

  function remove(storageKey) {
    if (!storageKey) return;
    try { fs.unlinkSync(resolveKey(storageKey)); } catch { /* Best-effort cleanup of replaced or removed avatar file. */ }
  }

  return { MAX_AVATAR_BYTES, readStream, resolveKey, remove };
}

module.exports = { createAvatarStorage, detectImageMime, MAX_AVATAR_BYTES };
