import { DEMO_USER_ID, PROFILE_AVATARS } from '@/profiles/profileModel';
import { AUTH_FIELDS, AuthError, validateLogin, validateRegistration, type AuthField, type AuthResult, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from './authModel';
import type { AuthService } from './authService';
import { ApiError, type ApiRequest, type SessionApi } from '@/api/sessionApi';

export interface AuthEndpoints { csrf: string; login: string; register: string; logout: string; me: string }
export interface HttpAuthServiceOptions {
  /** Same-public-origin path prefix. Cross-origin credentialed auth is unsupported by DB-2. */
  basePath?: string;
  endpoints?: Partial<AuthEndpoints>;
  getCsrfToken?: (signal: AbortSignal) => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export const PROPOSED_AUTH_ENDPOINTS: Readonly<AuthEndpoints> = {
  csrf: '/api/auth/csrf', login: '/api/auth/login', register: '/api/auth/register', logout: '/api/auth/logout', me: '/api/auth/me',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function authUser(value: unknown): AuthUser {
  if (!isRecord(value) || value.isDemo !== false ||
    !['id', 'username', 'displayName'].every((key) => typeof value[key] === 'string' &&
      (value[key] as string).trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value[key] as string)) ||
    !PROFILE_AVATARS.some((avatar) => avatar.id === value.avatar) ||
    value.id === DEMO_USER_ID || /^demo[-_:]/i.test(value.id as string)) {
    throw new AuthError('invalid_response');
  }
  return { id: value.id as string, username: value.username as string, displayName: value.displayName as string,
    avatar: value.avatar as AuthUser['avatar'], isDemo: false };
}

/** DB-2 same-origin cookie adapter. It never reads or retains a session bearer. */
export class HttpAuthService implements AuthService {
  readonly mode = 'api' as const;
  private readonly endpoints: AuthEndpoints;
  private readonly requestFetch: typeof fetch;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly sessionReads = new Set<AbortController>();
  private currentLookup: Promise<AuthUser | null> | null = null;
  private apiEpoch = 0;
  private readonly apiRequests = new Set<AbortController>();

  private cancelApiRequests(): void {
    this.apiEpoch += 1;
    for (const controller of this.apiRequests) controller.abort();
    this.apiRequests.clear();
  }

  constructor(private readonly options: HttpAuthServiceOptions = {}) {
    const basePath = options.basePath ?? '/api/auth';
    if (!/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(basePath) || basePath.endsWith('/')) throw new AuthError('unavailable');
    this.endpoints = { csrf: `${basePath}/csrf`, login: `${basePath}/login`, register: `${basePath}/register`,
      logout: `${basePath}/logout`, me: `${basePath}/me`, ...options.endpoints };
    if (!Object.values(this.endpoints).every((endpoint) => typeof endpoint === 'string' && /^\/(?!\/)[A-Za-z0-9/_-]+$/.test(endpoint))) {
      throw new AuthError('unavailable');
    }
    this.requestFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private async csrf(signal: AbortSignal): Promise<string> {
    if (this.options.getCsrfToken) return await this.options.getCsrfToken(signal) ?? '';
    const response = await this.requestFetch(this.endpoints.csrf, {
      method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      signal, headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) return this.failure(response, 'csrf', signal);
    const body = await this.json(response, signal);
    if (Object.keys(body).some(key => key !== 'csrfToken' && key !== 'expiresAt') ||
      typeof body.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.csrfToken) ||
      typeof body.expiresAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt) ||
      !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()) throw new AuthError('invalid_response');
    return body.csrfToken;
  }

  private async request<T>(
    operation: keyof AuthEndpoints,
    body: unknown,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (operation === 'me') this.sessionReads.add(controller);
    else {
      this.cancelApiRequests();
      // A late lookup must not invalidate or restore an actor after a newer auth mutation.
      for (const read of this.sessionReads) read.abort();
      this.sessionReads.clear(); this.currentLookup = null;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new AuthError('network')); }, 15_000);
    });
    const execute = async () => {
      const mutation = operation !== 'me' && operation !== 'csrf';
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (mutation) {
        let token: string | null;
        try { token = await this.csrf(controller.signal); }
        catch (failure) { throw failure instanceof AuthError ? failure : new AuthError('network'); }
        if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new AuthError('unavailable');
        headers['X-CSRF-Token'] = token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
      }
      if (controller.signal.aborted) throw new AuthError('network');
      let response: Response;
      try {
        response = await this.requestFetch(this.endpoints[operation], {
          method: mutation ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
          signal: controller.signal, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new AuthError('network'); }
      if (controller.signal.aborted) throw new AuthError('network');
      return consume(response, controller.signal);
    };
    try { return await Promise.race([execute(), timedOut]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); this.sessionReads.delete(controller); }
  }

  private async json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await response.json();
      if (signal.aborted) throw new AuthError('network');
      if (!isRecord(body)) throw new Error();
      return body;
    } catch { throw new AuthError(signal.aborted ? 'network' : 'invalid_response'); }
  }

  private invalidate(): void {
    this.cancelApiRequests();
    for (const listener of this.invalidationListeners) {
      try { listener(); } catch { /* Consumers must not interrupt session invalidation. */ }
    }
  }

  private async failure(response: Response, operation: keyof AuthEndpoints, signal: AbortSignal): Promise<never> {
    if (response.status === 401) {
      if (operation === 'logout') throw new AuthError('logout_failed');
      if (operation !== 'login') this.invalidate();
      throw new AuthError(operation === 'login' ? 'invalid_credentials' : 'unauthorized');
    }
    if (response.status === 429) {
      const raw = response.headers?.get('Retry-After');
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
      throw new AuthError('rate_limited', [], seconds && Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : undefined);
    }
    if (response.status === 403) {
      let code: unknown;
      try { code = (await this.json(response, signal)).code; } catch { /* No raw diagnostics. */ }
      throw new AuthError(code === 'CSRF_INVALID' ? 'csrf_invalid' : 'forbidden');
    }
    if (operation === 'logout') throw new AuthError('logout_failed');
    if (operation === 'register' && response.status === 409) throw new AuthError('account_unavailable');
    if (response.status === 400 || response.status === 422) {
      let fields: AuthField[] = [];
      try {
        const body = await this.json(response, signal);
        if (Array.isArray(body.fields)) fields = body.fields.filter((field): field is AuthField =>
          typeof field === 'string' && AUTH_FIELDS.includes(field as AuthField));
      } catch { /* Backend diagnostics are optional and never displayed. */ }
      throw new AuthError('validation', fields);
    }
    if (response.status >= 500) throw new AuthError('service_unavailable');
    if (response.status === 404) throw new AuthError('unavailable');
    throw new AuthError('invalid_response');
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const validation = validateLogin(input);
    if (!validation.valid) throw new AuthError('validation', Object.keys(validation.errors) as AuthField[]);
    return this.request('login', validation.value, async (response, signal) => {
      if (response.status !== 200) return this.failure(response, 'login', signal);
      const established = authUser((await this.json(response, signal)).user);
      // A success JSON response alone does not prove that the browser accepted the cookie.
      let verified: Response;
      try { verified = await this.requestFetch(this.endpoints.me, { method: 'GET', credentials: 'same-origin',
        mode: 'same-origin', redirect: 'error', cache: 'no-store', signal, headers: { Accept: 'application/json' } }); }
      catch { throw new AuthError('network'); }
      if (signal.aborted) throw new AuthError('network');
      if (verified.status !== 200) return this.failure(verified, 'me', signal);
      const confirmed = authUser((await this.json(verified, signal)).user);
      if (confirmed.id !== established.id || confirmed.username !== established.username) throw new AuthError('invalid_response');
      return { user: confirmed };
    });
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const validation = validateRegistration({ ...input, confirmPassword: input.password });
    if (!validation.valid) throw new AuthError('validation', Object.keys(validation.errors) as AuthField[]);
    return this.request('register', validation.value, async (response, signal) => {
      if (response.status !== 201) return this.failure(response, 'register', signal);
      const body = await this.json(response, signal);
      if (body.status === 'requires-login' && Object.keys(body).length === 1) return { status: 'requires-login' };
      throw new AuthError('invalid_response');
    });
  }

  getCurrentUser(): Promise<AuthUser | null> {
    if (this.currentLookup) return this.currentLookup;
    const lookup = this.request('me', undefined, async (response, signal) => {
      if (response.status === 401) { this.invalidate(); return null; }
      if (response.status !== 200) return this.failure(response, 'me', signal);
      const body = await this.json(response, signal);
      return body.user === null ? null : authUser(body.user);
    });
    this.currentLookup = lookup;
    const release = () => { if (this.currentLookup === lookup) this.currentLookup = null; };
    void lookup.then(release, release);
    return lookup;
  }

  async logout(): Promise<void> {
    return this.request('logout', undefined, async (response, signal) => {
      if (response.status !== 204) return this.failure(response, 'logout', signal);
      this.invalidate();
    });
  }

  subscribeToInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => { this.invalidationListeners.delete(listener); };
  }

  private async apiFailure(response: Response, signal: AbortSignal): Promise<never> {
    let code: unknown; let fields: string[] = [];
    try {
      const body = await this.json(response, signal);
      code = body.code;
      if (Array.isArray(body.fields)) fields = body.fields.filter((field): field is string =>
        typeof field === 'string' && ['displayName', 'statusMessage', 'avatar', 'presencePreference', 'q', 'userId'].includes(field));
    } catch { /* HTTP status remains meaningful even when diagnostics are not JSON. */ }
    const rawRetry = response.headers?.get('Retry-After');
    const retry = rawRetry && /^\d{1,5}$/.test(rawRetry) ? Number(rawRetry) : undefined;
    const keyCodes = {
      RECIPIENT_KEYS_CHANGED: 'recipient_keys_changed', RECIPIENT_KEYS_UNVERIFIED: 'recipient_keys_unverified',
      RECIPIENT_KEYS_UNAVAILABLE: response.status === 409 ? 'recipient_keys_missing' : 'key_service_unavailable',
      KEY_PROOF_INVALID: 'key_proof_invalid', KEY_CONFLICT: 'key_conflict', DEVICE_LIMIT: 'device_limit', IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
    } as const;
    if ([400, 403, 409, 503].includes(response.status) && typeof code === 'string' && Object.prototype.hasOwnProperty.call(keyCodes, code)) {
      throw new ApiError(keyCodes[code as keyof typeof keyCodes]);
    }
    throw new ApiError(response.status === 429 ? 'rate_limited' : response.status === 403 ?
      (code === 'CSRF_INVALID' ? 'csrf_invalid' : 'forbidden') : response.status === 404 ? 'not_found' :
      response.status === 409 ? (code === 'STALE_STATE' ? 'stale_state' : 'conflict') :
      [400, 422].includes(response.status) ? 'validation' :
      response.status === 503 && code === 'FEATURE_UNAVAILABLE' ? 'feature_unavailable' :
      response.status >= 500 ? 'service_unavailable' : 'invalid_response',
    fields, retry && retry <= 86400 ? retry : undefined);
  }

  /** Shares DB-2 cookies, CSRF bootstrap, fetch and invalidation with authentication. */
  createSessionApi(actor: AuthUser): SessionApi {
    const epoch = this.apiEpoch;
    const identity = { id: actor.id, username: actor.username };
    const controllers = new Set<AbortController>();
    let disposed = false;
    const request = async (path: string, options: ApiRequest = {}, binary?: {body?:Blob}): Promise<unknown> => {
      const handshake = path === this.endpoints.csrf && (options.method ?? 'GET') === 'GET' && options.body === undefined;
      const social = /^\/api\/(?:users|friends|blocks)(?:[/?][A-Za-z0-9._~%/?=&:-]*)?$/.test(path);
      const secure = /^\/api\/(?:keys\/devices(?:\/[A-Za-z0-9_-]{22}\/revoke)?|conversations(?:\/dm|\/[A-Za-z0-9._:-]+(?:\/(?:messages|pins|reactions|keys(?:\/epochs(?:\/[A-Za-z0-9_-]{22})?)?))?)?|messages\/[A-Za-z0-9-]+(?:\/(?:read|pin|reaction))?)(?:\?[A-Za-z0-9._~%=&-]+)?$/.test(path);
      const attachmentJson=(path==='/api/attachments/limits'&&(options.method??'GET')==='GET')||
        (/^\/api\/attachments\/[0-9a-f-]{36}$/.test(path)&&options.method==='DELETE')||
        (/^\/api\/attachments\/batches\/[A-Za-z0-9._:-]+\/[0-9a-f-]{36}$/.test(path)&&options.method==='POST');
      const attachmentBinary=binary!==undefined&&((options.method==='POST'&&/^\/api\/attachments\?conversation_id=[A-Za-z0-9._:%-]+&message_id=[0-9a-f-]{36}&id=[0-9a-f-]{36}$/.test(path)&&binary.body instanceof Blob&&binary.body.size<=50*1024*1024+16)||
        (options.method==='GET'&&/^\/api\/attachments\/[0-9a-f-]{36}\/download$/.test(path)&&binary.body===undefined));
      const callToken=path==='/api/calls/token'&&options.method==='POST';
      if ((binary!==undefined ? !attachmentBinary : !social && !secure && !handshake && !attachmentJson&&!callToken) || path.includes('..') || path.includes('//')) {
        throw new ApiError('unavailable');
      }
      const controller = new AbortController();
      const active = () => !disposed && epoch === this.apiEpoch && !controller.signal.aborted;
      if (disposed || epoch !== this.apiEpoch || options.signal?.aborted) throw new ApiError('cancelled');
      controllers.add(controller); this.apiRequests.add(controller);
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const canceled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new ApiError('cancelled')), { once: true });
        timer = setTimeout(() => reject(new ApiError('unavailable')), binary?120_000:15_000);
      });
      const verifyIdentity = async () => {
        if (!active()) throw new ApiError('cancelled');
        const response = await this.requestFetch(this.endpoints.me, { method: 'GET', credentials: 'same-origin',
          mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!active()) throw new ApiError('cancelled');
        if (response.status === 401) { this.invalidate(); throw new ApiError('unauthorized'); }
        if (response.status !== 200) return this.apiFailure(response, controller.signal);
        const current = authUser((await this.json(response, controller.signal)).user);
        if (!active()) throw new ApiError('cancelled');
        if (current.id !== identity.id || current.username !== identity.username) {
          this.invalidate(); throw new ApiError('unauthorized');
        }
      };
      const execute = async () => {
        await verifyIdentity();
        if (handshake) {
          const csrfToken = await this.csrf(controller.signal);
          await verifyIdentity();
          if (!active()) throw new ApiError('cancelled');
          return { csrfToken };
        }
        const method = options.method ?? 'GET';
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (method !== 'GET') {
          headers['X-CSRF-Token'] = await this.csrf(controller.signal);
          if (!headers['X-CSRF-Token']) throw new ApiError('csrf_invalid');
        }
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if(binary){
          headers.Accept=options.method==='GET'?'application/octet-stream':'application/json';
          if(binary.body)headers['Content-Type']='application/octet-stream';
          await verifyIdentity();
        }
        if (!active()) throw new ApiError('cancelled');
        const response = await this.requestFetch(path, { method, credentials: 'same-origin', mode: 'same-origin',
          redirect: 'error', cache: 'no-store', signal: controller.signal, headers,
          ...(binary?.body ? {body:binary.body} : options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
        if (!active()) throw new ApiError('cancelled');
        if (response.status === 401) { this.invalidate(); throw new ApiError('unauthorized'); }
        const statuses = Array.isArray(options.status) ? options.status : [options.status ?? 200];
        if (!statuses.includes(response.status)) {
          return this.apiFailure(response, controller.signal);
        }
        let result:unknown;
        if(binary&&options.method==='GET'){
          const max=50*1024*1024+16;
          if(response.headers.get('Content-Type')?.split(';')[0]!=='application/octet-stream'||Number(response.headers.get('Content-Length'))>max||!response.body)throw new ApiError('invalid_response');
          const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
          try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>max)throw new ApiError('resource_limit');chunks.push(chunk.value);}}
          finally{await reader.cancel().catch(()=>{});}
          const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}result=bytes.buffer;
        }else result=response.status===204?undefined:await this.json(response,controller.signal);
        await verifyIdentity();
        if (!active()) throw new ApiError('cancelled');
        return result;
      };
      try { return await Promise.race([execute(), canceled]); }
      catch (failure) {
        if (failure instanceof ApiError) throw failure;
        if (failure instanceof AuthError && (failure.code === 'csrf_invalid' || failure.code === 'forbidden' ||
          failure.code === 'rate_limited' || failure.code === 'service_unavailable' || failure.code === 'invalid_response' ||
          failure.code === 'unauthorized')) {
          throw new ApiError(failure.code, [], failure.retryAfterSeconds);
        }
        throw new ApiError('unavailable');
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort(); controllers.delete(controller); this.apiRequests.delete(controller);
        options.signal?.removeEventListener('abort', abort);
      }
    };
    return { actor: identity, request,
      binary:(path,options)=>request(path,{method:options.method,signal:options.signal,...(options.method==='POST'?{status:201 as const}:{})},{...(options.body?{body:options.body}:{})}),
      realtimeAuth: () => request(this.endpoints.csrf) as Promise<{ csrfToken: string }>,
      invalidateSession: () => { if (!disposed && epoch === this.apiEpoch) this.invalidate(); },
      dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); } };
  }
}
