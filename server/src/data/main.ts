/**
 * Combined process: DATA's API and the realtime server on ONE HTTP server (`npm run start:data`).
 *
 * DATA is loaded from `DATA_ROOT` (default `../DATA`, relative to the working directory) through
 * `createRequire`, so Kiro's source never imports DATA's code statically. DATA reads its own
 * configuration (`DATA/.env`, `PORT`, `HOST`, `DB_PATH`, `AUTH_*`). The realtime server then takes
 * everything it needs from DATA's application object: origins, session cookie name, trusted proxies,
 * sessions, membership, key verification and persistence.
 *
 * A DATA that cannot start, or one that lacks a method the bridge requires, stops the process.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createConsoleLogger } from '../realtime/logger.ts';
import { attachRealtimeToData } from './bridge.ts';

const logger = createConsoleLogger();

interface StartedData {
  readonly server: import('node:http').Server;
  close(): Promise<void>;
}

/**
 * DATA builds the one start-failure line (setting names of a FeatureConfigError, or the code and file name of a
 * MIGRATION_FAILED; never a value, a cause or a path). It is the same line `DATA/server.js` prints (T-5C-06).
 * Until DATA is loaded, and for a DATA that has no such function, there is no line.
 */
type DescribeStartFailure = (error: unknown) => string | null;
let describeStartFailure: DescribeStartFailure = () => null;

async function main(): Promise<void> {
  const dataRoot = resolve(process.env.DATA_ROOT ?? '../DATA');
  const requireData = createRequire(join(dataRoot, 'package.json'));
  const { startServer } = requireData('./server.js') as { startServer(): Promise<StartedData & Record<string, unknown>> };
  const { describeStartFailure: describe } = requireData('./server/start.js') as { describeStartFailure?: DescribeStartFailure };
  if (typeof describe === 'function') describeStartFailure = describe;
  const data = await startServer();
  const bridge = attachRealtimeToData(data.server, data, { logger });
  const address = data.server.address();
  logger.log('info', 'realtime.data.listening', {
    port: typeof address === 'object' && address !== null ? address.port : null,
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.log('info', 'realtime.data.shutdown', { signal });
    void bridge.close().then(() => data.close()).catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: unknown) => {
  try {
    const line = describeStartFailure(error);
    if (typeof line === 'string') process.stderr.write(`${line.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '?').slice(0, 400)}\n`);
  } catch {
    /* The line is best effort; the JSON event below always follows. */
  }
  logger.log('error', 'realtime.data.start_failed', { name: error instanceof Error ? error.name : 'unknown' });
  process.exitCode = 1;
});
