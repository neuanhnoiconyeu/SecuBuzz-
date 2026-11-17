import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachRealtimeServer } from '../../src/realtime/server.ts';
import { loadLiveKitConfig, createLiveKitHttpHandler, createDirectCallMediaLifecycle, type DirectCallRoomService } from '../../src/livekit/index.ts';
import { TokenBucket } from '../../src/realtime/rateLimiter.ts';
import { isPlainObject, hasOnlyKeys } from '../../src/realtime/validation.ts';
import { DevelopmentCallAdapters, DEVELOPMENT_COOKIE, DEVELOPMENT_USERS, DEVELOPMENT_CONVERSATION_ID, SESSION_TTL_MS } from './adapters.ts';
import { loadDevelopmentCallingConfig } from './config.ts';
import { createDevelopmentLiveKitStatus, type DevelopmentLiveKitProbe } from './livekitStatus.ts';

const loopback = (address: string | undefined) => Boolean(address && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address));
function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function body(request: IncomingMessage): Promise<unknown> {
  return new Promise(resolve => {
    let size = 0, done = false; const chunks: Buffer[] = [];
    const finish = (value: unknown) => { if (done) return; done = true; clearTimeout(timer); request.off('data', data); request.off('end', end);
      request.off('error', failed); request.off('aborted', failed); if (!request.readableEnded) request.resume(); resolve(value); };
    const failed = () => finish(null);
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 1024) finish(null); else chunks.push(chunk); };
    const end = () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { failed(); } };
    const timer = setTimeout(failed, 5000); timer.unref();
    request.on('data', data); request.on('end', end); request.on('error', failed); request.on('aborted', failed);
  });
}

/** Separate executable composition; production src/ never imports this module. */
export async function startDevelopmentCallingHarness(env: NodeJS.ProcessEnv, testOptions?: { roomService: DirectCallRoomService; probe?: DevelopmentLiveKitProbe }) {
  const config = loadDevelopmentCallingConfig(env);
  const adapters = new DevelopmentCallAdapters(config);
  const livekit = loadLiveKitConfig(env);
  const livekitStatus = createDevelopmentLiveKitStatus(livekit, env.LIVEKIT_ENABLED === 'true', testOptions?.probe);
  const budget = new TokenBucket({ capacity: 100, refillPerSecond: 5 });
  let route: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const http = createServer((request, response) => { void route(request, response).catch(() => { request.resume(); json(response, 503, { error: 'development_service_unavailable' }); }); });
  const realtime = attachRealtimeServer(http, { allowedOrigins: [config.appOrigin], sessionCookieName: DEVELOPMENT_COOKIE,
    sessionResolver: adapters, authorizer: adapters,
    directCalls: { conversationResolver: adapters,
      ...(livekit.directCallsReady ? { media: createDirectCallMediaLifecycle(livekit, testOptions?.roomService) } : {}) } });
  const tokens = createLiveKitHttpHandler({ config: livekit, allowedOrigins: [config.appOrigin], sessionCookieName: DEVELOPMENT_COOKIE,
    sessionResolver: adapters, authorizer: adapters, verifyCsrf: async (request, actor) => adapters.verifyCsrf(request, actor), directCalls: realtime });
  const cookie = (token: string, age = SESSION_TTL_MS / 1000) => `${DEVELOPMENT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.appOrigin.startsWith('https:') ? '; Secure' : ''}`;
  route = async (request, response) => {
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); } catch { json(response, 403, { error: 'local_only' }); return; }
    if (!loopback(request.socket.remoteAddress) || !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) ||
      host.username || host.password || host.pathname !== '/' || host.search || host.hash) { json(response, 403, { error: 'local_only' }); return; }
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' || (origin !== undefined && origin !== config.appOrigin) ||
      (request.method !== 'GET' && origin !== config.appOrigin)) { request.resume(); json(response, 403, { error: 'origin_denied' }); return; }
    if (!budget.take()) { request.resume(); json(response, 429, { error: 'rate_limited' }); return; }
    if (await tokens(request, response)) return;
    const path = request.url?.split('?')[0];
    if (request.method === 'GET' && path === '/healthz') { json(response, 200, { developmentOnly: true, mediaConfigured: livekit.directCallsReady }); return; }
    if (request.method === 'GET' && path === '/api/dev-calling/bootstrap') {
      let session = adapters.session(request);
      if (!session) { session = adapters.create(null); response.setHeader('set-cookie', cookie(session.token)); }
      json(response, 200, { developmentOnly: true, csrfToken: session.csrf, users: DEVELOPMENT_USERS, conversationId: DEVELOPMENT_CONVERSATION_ID, mediaConfigured: livekit.directCallsReady }); return;
    }
    if (request.method === 'GET' && path === '/api/auth/me') { json(response, 200, { user: adapters.session(request)?.user ?? null }); return; }
    if (request.method === 'GET' && path === '/api/dev-calling/status') {
      if (!adapters.session(request)?.user) { json(response, 401, { error: 'authentication_required' }); return; }
      json(response, 200, { developmentOnly: true, mediaConfigured: livekit.directCallsReady, livekit: await livekitStatus() }); return;
    }
    if (request.method === 'GET' && path === '/api/dev-calling/context') {
      const session = adapters.session(request);
      if (!session?.user) { json(response, 401, { error: 'authentication_required' }); return; }
      json(response, 200, { developmentOnly: true, user: session.user, peer: DEVELOPMENT_USERS.find(user => user.id !== session.user!.id),
        conversation: { id: DEVELOPMENT_CONVERSATION_ID, type: 'direct', participants: DEVELOPMENT_USERS } }); return;
    }
    if (request.method !== 'POST' || !['/api/auth/login', '/api/auth/logout'].includes(path ?? '')) { request.resume(); json(response, 404, { error: 'not_found' }); return; }
    if (!adapters.verifyCsrf(request)) { request.resume(); json(response, 403, { error: 'csrf_denied' }); return; }
    if (path === '/api/auth/logout') {
      const session = adapters.session(request)!; adapters.revoke(session.sessionId); realtime.revokeSession(session.sessionId);
      response.setHeader('set-cookie', cookie('', 0)); json(response, 200, { success: true }); return;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { request.resume(); json(response, 415, { error: 'invalid_payload' }); return; }
    const input = await body(request);
    if (!isPlainObject(input) || !hasOnlyKeys(input, ['identifier', 'password']) || typeof input.identifier !== 'string' || typeof input.password !== 'string') { json(response, 400, { error: 'invalid_payload' }); return; }
    const user = adapters.credentials(input.identifier, input.password);
    if (!user) { json(response, 401, { error: 'invalid_credentials' }); return; }
    // Revalidate the bootstrap session after asynchronous request consumption.
    const previous = adapters.session(request);
    if (!previous || !adapters.verifyCsrf(request)) { json(response, 403, { error: 'csrf_denied' }); return; }
    const session = adapters.create(user);
    adapters.revoke(previous.sessionId); realtime.revokeSession(previous.sessionId);
    response.setHeader('set-cookie', cookie(session.token)); json(response, 200, { user, csrfToken: session.csrf });
  };
  try { await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '127.0.0.1', () => { http.off('error', reject); resolve(); }); }); }
  catch (error) { await realtime.close(); adapters.clear(); throw error; }
  let closing: Promise<void> | null = null;
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, mediaConfigured: livekit.directCallsReady, realtime,
    close(): Promise<void> { return closing ??= (async () => { await realtime.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); adapters.clear(); })(); } };
}
