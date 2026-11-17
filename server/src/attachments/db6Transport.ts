import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

const uploadPath = /^\/api\/(?:attachments|files)\/?$/;
const downloadPath = /^\/api\/(?:attachments|files)\/[^/]+\/download\/?$/;
const encoding = 'percent-utf8';

function filename(request: IncomingMessage): boolean {
  const marker = request.headers['x-file-name-encoding'];
  if (marker === undefined) return true; // Existing DB6 clients send literal names, including literal percent signs.
  const raw = request.headers['x-file-name'];
  if (marker !== encoding || typeof raw !== 'string' || raw.length > 180 * 9) return false;
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || decoded.length > 180 || /[\\/\u0000-\u001f\u007f-\u009f]/u.test(decoded)) return false;
    request.headers['x-file-name'] = decoded;
    delete request.headers['x-file-name-encoding'];
    return true;
  } catch { return false; }
}

/** Turn DB6's quoted filename into an ASCII header with an RFC 5987 UTF-8 filename. */
function disposition(value: string): string {
  const match = /^attachment; filename="([^"]*)"$/.exec(value);
  if (!match) return value;
  const name = match[1]!;
  const fallback = name.replace(/[^\x20-\x7e]|[\\"]/gu, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

/**
 * Transport adaptation only: DB6 still owns all routes, authentication, SQL, storage and retention.
 * Mount around createApiApp(), before any body parsing. File bytes are never read or rewritten here.
 */
export function createDb6AttachmentTransport(api: RequestListener): RequestListener {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const path = request.url?.split('?')[0] ?? '';
    if (request.method === 'POST' && uploadPath.test(path) && !filename(request)) {
      response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'invalid_filename' }));
      return;
    }
    if (downloadPath.test(path)) {
      const original = response.setHeader;
      response.setHeader = function (name, value) {
        return original.call(this, name, name.toLowerCase() === 'content-disposition' && typeof value === 'string' ? disposition(value) : value);
      };
    }
    api(request, response);
  };
}
