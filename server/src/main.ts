/**
 * Standalone realtime process: `npm start` (reads `server/.env` when present).
 *
 * It configures no SessionResolver, RealtimeAuthorizer, MessageStore or RecipientKeyVerifier,
 * because the Database and Security teams have not delivered them. The server therefore runs in
 * fail-closed mode and rejects every connection with REALTIME_UNAVAILABLE. To integrate, mount
 * `attachRealtimeServer` on the API server with real adapters (docs/realtime-server-integration.md).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadStandaloneConfig, RealtimeConfigError } from './realtime/config.ts';
import { createConsoleLogger } from './realtime/logger.ts';
import { attachRealtimeServer } from './realtime/server.ts';

const logger = createConsoleLogger();

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && request.url === '/healthz') respond(response, 200, '{"status":"ok"}');
  else respond(response, 404, '{"error":"not_found"}');
}

async function main(): Promise<void> {
  const { host, port, options } = loadStandaloneConfig(process.env);
  const httpServer = createServer(handleHttp);
  const realtime = attachRealtimeServer(httpServer, { ...options, logger });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  logger.log('info', 'realtime.listening', { host: address.address, port: address.port, path: options.path ?? '/socket.io' });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.log('info', 'realtime.shutdown', { signal });
    void realtime.close().finally(() => httpServer.close());
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.log('error', 'realtime.start_failed', {
    name: error instanceof Error ? error.name : 'unknown',
    // Configuration messages are authored by this module and contain no secrets.
    message: error instanceof RealtimeConfigError ? error.message : null,
  });
  process.exitCode = 1;
});
