/**
 * TEST-ONLY harness that runs the real, unmodified DATA application (DB-2 auth, DB-3 social,
 * DB-4A conversations, DB-4B messaging) on an isolated temporary SQLite file, loaded read-only from
 * `DATA/` with its own dependencies. It never touches DATA's development database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') throw new Error('The DATA test harness must never be loaded in production.');

export const DATA_ROOT = fileURLToPath(new URL('../../../../DATA/', import.meta.url));
/** `require` anchored inside DATA, exactly as DATA's own modules resolve. */
export const requireFromData = createRequire(join(DATA_ROOT, 'server', 'app.js'));
export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'Synthetic passphrase for e2ee tests 2026!';
const ENV = Object.freeze({ NODE_ENV: 'test', AUTH_ALLOW_HTTP_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: ORIGIN, HOST: '127.0.0.1', PORT: '0' });

interface DataResponse {
  readonly status: number;
  readonly body: any;
}

/** Minimal browser: same-origin cookies, Origin header, JSON and DB-2 CSRF bootstrap. */
export class Browser {
  readonly cookies = new Map<string, string>();
  base: string;
  token = '';

  constructor(base: string) {
    this.base = base;
  }

  async request(path: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<DataResponse> {
    const response = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        Origin: ORIGIN,
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0] as string;
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1);
      if (value) this.cookies.set(pair.slice(0, index), value);
      else this.cookies.delete(pair.slice(0, index));
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async csrf(): Promise<string> {
    const response = await this.request('/api/auth/csrf');
    if (response.status !== 200) throw new Error('CSRF bootstrap failed');
    this.token = response.body.csrfToken as string;
    return this.token;
  }

  async mutate(method: string, path: string, body?: unknown): Promise<DataResponse> {
    return this.request(path, { method, body, headers: { 'X-CSRF-Token': this.token || await this.csrf() } });
  }
}

export interface DataAccount {
  readonly browser: Browser;
  readonly id: string;
  readonly displayName: string;
}

/** One running DATA application. pplication is DATA's own object (createApp result plus server, db, close). */
export interface StartedData {
  readonly url: string;
  close(): Promise<void>;
  readonly application: Record<string, any>;
  readonly server: HttpServer;
}

export interface DataFixture {
  readonly filename: string;
  readonly config: { readonly sessionCookie: string };
  /** Starts another DATA app on the same database with DB-4B message options and DATA's own injectable dependencies (for example `now`). */
  start(messageOptions?: Record<string, unknown>, dependencies?: Record<string, unknown>): Promise<StartedData>;
  register(username: string, displayName: string, base: string): Promise<DataAccount>;
  databaseText(): string;
  close(): Promise<void>;
}

export async function createDataFixture(): Promise<DataFixture> {
  const { openDatabase } = requireFromData('./database/connection');
  const { loadAuthConfig } = requireFromData('./auth/config');
  const { startServer } = requireFromData('./start');
  const directory = mkdtempSync(join(tmpdir(), 'secubuzz-e2ee-'));
  const filename = join(directory, 'data.sqlite');
  const db = openDatabase({ filename });
  const config = loadAuthConfig(ENV);
  const apps: Array<{ close(): Promise<void>; server: { listening: boolean } }> = [];
  return {
    filename,
    config,
    async start(messageOptions = {}, dependencies = {}) {
      const app = await startServer({ db, config, env: ENV, messageOptions, ...dependencies });
      apps.push(app);
      return { url: `http://127.0.0.1:${app.server.address().port}`, close: () => app.close(), application: app, server: app.server };
    },
    async register(username, displayName, base) {
      const browser = new Browser(base);
      const registered = await browser.request('/api/auth/register', { method: 'POST', headers: { 'X-CSRF-Token': await browser.csrf() },
        body: { username, email: `${username}@example.test`, password: PASSWORD, displayName } });
      if (registered.status !== 201) throw new Error(`register ${username}: ${registered.status}`);
      const login = await browser.request('/api/auth/login', { method: 'POST', headers: { 'X-CSRF-Token': await browser.csrf() },
        body: { identifier: username, password: PASSWORD } });
      if (login.status !== 200) throw new Error(`login ${username}: ${login.status}`);
      await browser.csrf();
      return { browser, id: login.body.user.id as string, displayName };
    },
    databaseText() {
      return readdirSync(directory).map((name) => readFileSync(join(directory, name)).toString('latin1')).join('\n');
    },
    async close() {
      for (const app of apps.reverse()) if (app.server.listening) await app.close();
      if (db.open) db.close();
      for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
      rmdirSync(directory);
    },
  };
}
