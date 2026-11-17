import { HttpAuthService } from '../httpAuthService';
import { createConfiguredAuthService } from '../authService';

const user = { id: 'real-account', username: 'person', displayName: 'Person', avatar: 'initials', isDemo: false } as const;
const login = { identifier: 'PERSON', password: '  real password bytes  ' };
const register = { username: 'PERSON', email: 'Person@example.test', password: login.password };
const proof = (letter = 'A') => ({ csrfToken: letter.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() });
const response = (status: number, body?: unknown, retry?: string) => ({ status, json: jest.fn().mockResolvedValue(body),
  headers: { get: (name: string) => name === 'Retry-After' ? retry ?? null : null } }) as unknown as Response;
const setup = (...replies: Response[]) => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  return { service: new HttpAuthService({ fetch: fetcher }), fetcher };
};
afterEach(() => jest.restoreAllMocks());

test('fresh DB-2 bootstrap precedes every mutation; registration never authenticates or replays the password', async () => {
  const { service, fetcher } = setup(response(200, proof('A')), response(201, { status: 'requires-login' }),
    response(200, proof('B')), response(200, { user }), response(200, { user }), response(200, proof('C')), response(204));
  expect(await service.register(register)).toEqual({ status: 'requires-login' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await service.login(login)).toEqual({ user });
  await service.logout();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/csrf','/api/auth/register',
    '/api/auth/csrf','/api/auth/login','/api/auth/me','/api/auth/csrf','/api/auth/logout']);
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(init?.headers).not.toHaveProperty('Cookie');
    expect(init?.headers).not.toHaveProperty('Origin');
  }
  for (const [index, letter] of [[1,'A'],[3,'B'],[6,'C']] as const) {
    expect(fetcher.mock.calls[index]?.[1]?.headers).toHaveProperty('X-CSRF-Token',letter.repeat(43));
  }
  expect(fetcher.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ identifier: 'person', password: login.password }));
  expect(fetcher.mock.calls[6]?.[1]).not.toHaveProperty('body');
});

test.each([{}, {csrfToken:'bad',expiresAt:'tomorrow'}, {csrfToken:'A'.repeat(43),expiresAt:'2000-01-01T00:00:00Z'},
  {csrfToken:'A'.repeat(43),expiresAt:'not-a-date'}, {...proof(),sessionToken:'must-not-be-accepted'}])(
  'invalid bootstrap never sends credentials (%j)', async body => {
    const { service, fetcher } = setup(response(200,body));
    await expect(service.login(login)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

test.each([401,503])('login JSON alone cannot authenticate if cookie confirmation fails with %i', async status => {
  const { service } = setup(response(200,proof()), response(200,{user}), response(status));
  await expect(service.login(login)).rejects.toMatchObject({ code: status === 401 ? 'unauthorized' : 'service_unavailable' });
});
test('mismatched /me identity cannot establish the actor returned by login', async () => {
  const { service } = setup(response(200,proof()),response(200,{user}),response(200,{user:{...user,id:'another-account'}}));
  await expect(service.login(login)).rejects.toMatchObject({code:'invalid_response'});
});

test.each(['wrong password','unknown account'])('%s uses the same generic backend rejection without fallback', async () => {
  const { service, fetcher } = setup(response(200,proof()),response(401,{code:'INVALID_CREDENTIALS',fields:[]}));
  await expect(service.login(login)).rejects.toMatchObject({code:'invalid_credentials'});
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(service).not.toHaveProperty('continueAsDemo');
});
test('a CSRF rejection is never retried automatically; an explicit retry bootstraps anew', async () => {
  const { service, fetcher } = setup(response(200,proof('A')),response(403,{code:'CSRF_INVALID',fields:[]}),
    response(200,proof('B')),response(200,{user}),response(200,{user}));
  await expect(service.login(login)).rejects.toMatchObject({code:'csrf_invalid'});
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(service.login(login)).resolves.toEqual({user});
  expect(fetcher.mock.calls[3]?.[1]?.headers).toHaveProperty('X-CSRF-Token','B'.repeat(43));
});
test.each([true,false])('rate limiting during bootstrap or mutation is safe and does not replay writes (%s)', async bootstrap => {
  const limited=response(429,{code:'RATE_LIMITED',fields:[]},'60');
  const {service,fetcher}=setup(...(bootstrap ? [limited] : [response(200,proof()),limited]));
  await expect(service.login(login)).rejects.toMatchObject({code:'rate_limited',retryAfterSeconds:60});
  expect(fetcher).toHaveBeenCalledTimes(bootstrap ? 1 : 2);
});
test('logout failure does not broadcast confirmed revocation', async () => {
  const {service}=setup(response(200,proof()),response(401),response(200,proof()),response(503));
  const invalidated=jest.fn(); service.subscribeToInvalidation(invalidated);
  await expect(service.logout()).rejects.toMatchObject({code:'logout_failed'});
  await expect(service.logout()).rejects.toMatchObject({code:'logout_failed'});
  expect(invalidated).not.toHaveBeenCalled();
});
test('concurrent session checks share one lookup, then a later check uses the backend again', async () => {
  const {service,fetcher}=setup(response(200,{user}),response(401));
  const first=service.getCurrentUser(); const second=service.getCurrentUser();
  expect(first).toBe(second);
  expect(await first).toEqual(user);
  expect(await service.getCurrentUser()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('logout cancels a slow /me; its late 401 cannot invalidate a newer session', async () => {
  let finish!: (value:Response)=>void;
  const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>()
    .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValueOnce(response(200,proof())).mockResolvedValueOnce(response(204));
  const service=new HttpAuthService({fetch:fetcher}); const invalidated=jest.fn(); service.subscribeToInvalidation(invalidated);
  const restore=service.getCurrentUser(); const rejected=expect(restore).rejects.toMatchObject({code:'network'});
  await service.logout(); expect(invalidated).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  finish(response(401)); await rejected;
  expect(invalidated).toHaveBeenCalledTimes(1);
});
test('bootstrap shares the mutation deadline and cannot submit credentials after timeout', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value:Response)=>void;
    const fetcher=jest.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const service=new HttpAuthService({fetch:fetcher});
    const pending=service.login(login); const rejected=expect(pending).rejects.toMatchObject({code:'network'});
    await jest.advanceTimersByTimeAsync(15_000); await rejected;
    finish(response(200,proof())); await Promise.resolve(); await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally {jest.useRealTimers();}
});
test('base path remains same-origin and never accepts URL credentials or traversal', () => {
  expect(new HttpAuthService({basePath:'/gateway/auth'}).mode).toBe('api');
  for (const basePath of ['https://api.example.test/auth','//evil.test','/api/../auth','/api/auth?token=x','/api/auth/']) {
    expect(()=>new HttpAuthService({basePath})).toThrow();
  }
});
test('configured application never selects demo credentials, even when the legacy flag is requested', () => {
  jest.replaceProperty(process,'env',{...process.env,NODE_ENV:'development',NEXT_PUBLIC_AUTH_MODE:'demo'});
  expect(createConfiguredAuthService().mode).toBe('unconfigured');
});

test.each([500,502,503,504])('proxy/backend HTTP %i during bootstrap is availability failure, even with a non-JSON body', async status => {
  const reply=response(status); (reply.json as jest.Mock).mockRejectedValue(new Error('private upstream diagnostics'));
  const {service,fetcher}=setup(reply);
  await expect(service.register(register)).rejects.toMatchObject({code:'service_unavailable',message:'The authentication service is temporarily unavailable. Please try again later.'});
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(reply.json).not.toHaveBeenCalled();
});
test.each([
  [400,{code:'VALIDATION_ERROR',fields:['email']},'validation'],
  [401,{code:'INVALID_CREDENTIALS'},'invalid_credentials'],
  [403,{code:'CSRF_INVALID'},'csrf_invalid'],
  [403,{code:'FORBIDDEN'},'forbidden'],
  [404,{code:'NOT_FOUND'},'unavailable'],
  [429,{code:'RATE_LIMITED'},'rate_limited'],
])('HTTP %i refusal retains its meaning instead of a generic unavailable message', async (status,body,code) => {
  const {service}=setup(response(200,proof()),response(status as number,body));
  await expect(service.login(login)).rejects.toMatchObject({code});
});
