import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { io as connectClient } from 'socket.io-client';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const children = new Set<ChildProcess>();

interface Started {
  readonly child: ChildProcess;
  readonly lines: Array<Record<string, unknown>>;
  readonly port: number;
}

function environment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('REALTIME_')) delete env[key];
  return { ...env, ...overrides };
}

function launch(overrides: Record<string, string>): { child: ChildProcess; lines: Array<Record<string, unknown>> } {
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: serverRoot, env: environment(overrides), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const lines: Array<Record<string, unknown>> = [];
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            lines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            lines.push({ raw: line });
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
  }
  return { child, lines };
}

async function start(overrides: Record<string, string>): Promise<Started> {
  const { child, lines } = launch(overrides);
  const started = Date.now();
  while (!lines.some((line) => line.event === 'realtime.listening')) {
    if (child.exitCode !== null) throw new Error(`standalone server exited early: ${JSON.stringify(lines)}`);
    if (Date.now() - started > 15_000) throw new Error('standalone server did not start');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const listening = lines.find((line) => line.event === 'realtime.listening')!;
  return { child, lines, port: Number(listening.port) };
}

describe('standalone entry point (node src/main.ts)', () => {
  after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });

  test('starts in fail-closed mode, serves a health check and rejects every connection', async () => {
    const { child, lines, port } = await start({ REALTIME_HOST: '127.0.0.1', REALTIME_PORT: '0', REALTIME_ALLOWED_ORIGINS: 'http://localhost:3000' });
    const startedLine = lines.find((line) => line.event === 'realtime.started');
    assert.equal(startedLine?.mode, 'fail-closed');
    assert.equal(startedLine?.messageDelivery, 'disabled');
    assert.equal(startedLine?.level, 'warn');

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const missing = await fetch(`http://127.0.0.1:${port}/api/users`);
    await missing.arrayBuffer();
    assert.equal(missing.status, 404);

    const socket = connectClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      extraHeaders: { origin: 'http://localhost:3000', cookie: 'secubuzz_session=anything' },
    });
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) => socket.once('connect_error', resolve));
    socket.disconnect();
    assert.equal(error.data?.code, 'REALTIME_UNAVAILABLE');
    assert.ok(!JSON.stringify(lines).includes('anything'), 'the presented cookie value is never logged');
    child.kill();
    await once(child, 'exit');
  });

  test('refuses to start with an invalid configuration', async () => {
    const { child, lines } = launch({ REALTIME_PORT: '0', REALTIME_ALLOWED_ORIGINS: '*' });
    const [code] = (await once(child, 'exit')) as [number | null];
    assert.equal(code, 1);
    const failure = lines.find((line) => line.event === 'realtime.start_failed');
    assert.equal(failure?.name, 'RealtimeConfigError');
    assert.match(String(failure?.message), /wildcard/i);
  });
});
