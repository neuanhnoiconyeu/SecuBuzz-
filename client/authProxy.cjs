/** Server-only Next.js routing. Preserve browser security headers and cookie attributes. */
function authProxyRewrites(env = process.env) {
  const basePath = env.NEXT_PUBLIC_AUTH_API_BASE_PATH || '/api/auth';
  if (!/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(basePath) || basePath.endsWith('/')) throw new Error('Invalid authentication API base path.');
  const target = env.AUTH_BACKEND_URL || (env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:5000');
  if (!target) return [];
  let url;
  try { url = new URL(target); } catch { throw new Error('Invalid AUTH_BACKEND_URL.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[\s\\]/.test(target) ||
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('AUTH_BACKEND_URL requires HTTPS, or loopback HTTP in development.');
  }
  return ['csrf', 'register', 'login', 'me', 'logout'].map(operation => ({
    source: `${basePath}/${operation}`, destination: `${url.origin}/api/auth/${operation}`,
  }));
}

function socialProxyRewrites(env = process.env) {
  const auth = authProxyRewrites(env);
  if (!auth.length) return [];
  const origin = new URL(auth[0].destination).origin;
  return [
    '/api/users/search', '/api/users/me', '/api/users/:id',
    '/api/friends/requests/:id/accept', '/api/friends/requests/:id/decline',
    '/api/friends/requests/:id', '/api/friends/requests', '/api/friends/:id', '/api/friends',
    '/api/blocks/:userId', '/api/blocks',
  ].map(source => ({ source, destination: `${origin}${source}` }));
}

function messagingProxyRewrites(env = process.env) {
  const auth = authProxyRewrites(env); if (!auth.length) return [];
  const origin = new URL(auth[0].destination).origin;
  return ['/api/keys/devices/:deviceId/revoke', '/api/keys/devices',
    '/api/conversations/:id/keys/epochs/:keyId', '/api/conversations/:id/keys/epochs', '/api/conversations/:id/keys',
    '/api/conversations/:id/messages', '/api/conversations/dm', '/api/conversations/:id', '/api/conversations',
    '/api/messages/:id/read', '/api/messages/:id'].map(source => ({ source, destination: `${origin}${source}` }));
}
function realtimeProxyRewrites(env = process.env) {
  const auth = authProxyRewrites(env); if (!auth.length) return [];
  // Engine.IO requires the trailing slash. An empty Next wildcard removes it.
  return [{ source: '/socket.io', destination: `${new URL(auth[0].destination).origin}/socket.io/` }];
}
module.exports = { authProxyRewrites, socialProxyRewrites, messagingProxyRewrites, realtimeProxyRewrites };
