// Next's external rewrite proxy handles both HTTP and WebSocket upgrades.
/** @param {Record<string, string | undefined>} env */
function callingRewrites(env = process.env) {
  if (env.SECUBUZZ_DEV_CALLS_PROXY !== 'true') return [];
  if (env.NODE_ENV !== 'development') throw new Error('Calling proxy requires next dev.');
  const target = new URL(env.DEV_CALLS_BACKEND_URL || 'http://127.0.0.1:5101');
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) throw new Error('Calling backend must be a loopback HTTP origin.');
  return [...['/api/auth/login', '/api/auth/me', '/api/auth/logout', '/api/dev-calling/:path*', '/api/calls/token']
    .map(source => ({ source, destination: `${target.origin}${source}` })),
    { source: '/socket.io', destination: `${target.origin}/socket.io/` }];
}
module.exports = { callingRewrites };
