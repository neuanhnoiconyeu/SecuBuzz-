import { HttpAuthService } from '@/auth/httpAuthService';
import { ApiError } from '../sessionApi';

const alice = { id: 'alice-id', username: 'alice', displayName: 'Alice', avatar: 'cat', isDemo: false } as const;
const bob = { ...alice, id: 'bob-id', username: 'bob' };
const response = (status: number, body?: unknown, retry?: string) => ({ status, json: async () => body,
  headers: { get: () => retry ?? null } }) as unknown as Response;
const proof = { csrfToken: 'A'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() };

test('realtime proof is freshly fetched and guarded by the same identity checks before and after', async () => {
  const { api, fetcher } = setup(response(200, { user: alice }), response(200, proof), response(200, { user: alice }),
    response(200, { user: alice }), response(200, { ...proof, csrfToken: 'B'.repeat(43) }), response(200, { user: alice }));
  await expect(api.realtimeAuth!()).resolves.toEqual({ csrfToken: proof.csrfToken });
  await expect(api.realtimeAuth!()).resolves.toEqual({ csrfToken: 'B'.repeat(43) });
  expect(fetcher.mock.calls.map(c => c[0])).toEqual(['/api/auth/me', '/api/auth/csrf', '/api/auth/me', '/api/auth/me', '/api/auth/csrf', '/api/auth/me']); api.dispose();
});
test('cookie account switching during CSRF bootstrap discards proof and invalidates the old actor', async () => {
  const { api, service } = setup(response(200, { user: alice }), response(200, proof), response(200, { user: bob }));
  const invalidated = jest.fn(); service.subscribeToInvalidation(invalidated); await expect(api.realtimeAuth!()).rejects.toBeInstanceOf(ApiError);
  expect(invalidated).toHaveBeenCalledTimes(1); api.dispose();
});
test('realtime session expiry uses existing provider invalidation and never returns CSRF', async () => {
  const { api, service } = setup(response(401)); const invalidated = jest.fn(); service.subscribeToInvalidation(invalidated);
  await expect(api.realtimeAuth!()).rejects.toBeInstanceOf(ApiError); expect(invalidated).toHaveBeenCalledTimes(1); api.dispose();
});
function setup(...responses: Response[]) {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  responses.forEach(result => fetcher.mockResolvedValueOnce(result));
  const service = new HttpAuthService({ fetch: fetcher });
  return { service, fetcher, api: service.createSessionApi(alice) };
}

test('direct-call tokens use scoped DATA identity, fresh CSRF and canonical POST routing',async()=>{
  const details={token:'test-only-signed-token'};
  const {api,fetcher}=setup(response(200,{user:alice}),response(200,proof),response(200,details),response(200,{user:alice}));
  const body={callId:'11111111-2222-4333-8444-555555555555',connectionId:'owned-socket'};
  await expect(api.request('/api/calls/token',{method:'POST',body})).resolves.toEqual(details);
  expect(fetcher.mock.calls[2]).toEqual(['/api/calls/token',expect.objectContaining({method:'POST',credentials:'same-origin',body:JSON.stringify(body),
    headers:expect.objectContaining({'X-CSRF-Token':proof.csrfToken})})]);
  for(const path of ['/api/calls/token/','/api/calls/token?userId=other','https://other.test/api/calls/token'])
    await expect(api.request(path,{method:'POST',body})).rejects.toMatchObject({code:'unavailable'});
  await expect(api.request('/api/calls/token')).rejects.toMatchObject({code:'unavailable'});api.dispose();
});

test('direct-call token responses are discarded after cookie account replacement',async()=>{
  const {api}=setup(response(200,{user:alice}),response(200,proof),response(200,{token:'do-not-use'}),response(200,{user:bob}));
  await expect(api.request('/api/calls/token',{method:'POST',body:{}})).rejects.toMatchObject({code:'cancelled'});api.dispose();
});

test('binary ciphertext upload shares session cookies, fresh CSRF and identity checks without JSON-encoding bytes',async()=>{
  const blob=new Blob([new Uint8Array(32)],{type:'application/octet-stream'}),path='/api/attachments?conversation_id=chat&message_id=00000000-0000-4000-8000-000000000000&id=00000000-0000-4000-8000-000000000001';
  const {api,fetcher}=setup(response(200,{user:alice}),response(200,proof),response(200,{user:alice}),response(201,{v:1}),response(200,{user:alice}));
  await expect(api.binary!(path,{method:'POST',body:blob})).resolves.toEqual({v:1});
  expect(fetcher.mock.calls[3]).toEqual([path,expect.objectContaining({credentials:'same-origin',redirect:'error',body:blob,
    headers:{Accept:'application/json','Content-Type':'application/octet-stream','X-CSRF-Token':proof.csrfToken}})]);
  api.dispose();
});
test('binary upload rejects an account switch during CSRF bootstrap before sending file bytes',async()=>{
  const {api,fetcher}=setup(response(200,{user:alice}),response(200,proof),response(200,{user:bob}));
  await expect(api.binary!('/api/attachments?conversation_id=chat&message_id=00000000-0000-4000-8000-000000000000&id=00000000-0000-4000-8000-000000000001',{method:'POST',body:new Blob(['ciphertext'])})).rejects.toBeInstanceOf(ApiError);
  expect(fetcher).toHaveBeenCalledTimes(3);api.dispose();
});
test('binary download is bounded and identity-checked after reading ciphertext',async()=>{
  let read=false;const cancel=jest.fn(async()=>{}),bytes=new Uint8Array([1,2,3]);
  const binary={status:200,headers:{get:(name:string)=>name==='Content-Type'?'application/octet-stream':'3'},body:{getReader:()=>({read:async()=>{if(read)return{done:true};read=true;return{done:false,value:bytes};},cancel})}} as unknown as Response;
  const {api,fetcher}=setup(response(200,{user:alice}),response(200,{user:alice}),binary,response(200,{user:alice}));
  await expect(api.binary!('/api/attachments/00000000-0000-4000-8000-000000000000/download',{method:'GET'})).resolves.toEqual(bytes.buffer);
  expect(fetcher).toHaveBeenCalledTimes(4);expect(cancel).toHaveBeenCalled();api.dispose();
});
test('binary transport rejects oversize responses and noncanonical or foreign routes',async()=>{
  const binary={status:200,headers:{get:(name:string)=>name==='Content-Type'?'application/octet-stream':String(60*1024*1024)},body:{}} as unknown as Response;
  const {api}=setup(response(200,{user:alice}),response(200,{user:alice}),binary);
  await expect(api.binary!('/api/attachments/00000000-0000-4000-8000-000000000000/download',{method:'GET'})).rejects.toMatchObject({code:'invalid_response'});
  for(const path of ['https://other.test/api/attachments','/api/files','/api/attachments/../download'])await expect(api.binary!(path,{method:'GET'})).rejects.toMatchObject({code:'unavailable'});
  api.dispose();
});

test('social writes share DB-2 bootstrap and cookie policy; server actor is checked before and after', async () => {
  const { api, fetcher } = setup(response(200, { user: alice }), response(200, proof), response(204), response(200, { user: alice }));
  await api.request('/api/blocks', { method: 'POST', body: { userId: bob.id }, status: 204 });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/auth/me', '/api/auth/csrf', '/api/blocks', '/api/auth/me']);
  for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ headers: { 'X-CSRF-Token': proof.csrfToken }, body: JSON.stringify({ userId: bob.id }) });
  api.dispose();
});

test('pin routes keep the same account checks, cookie policy and CSRF protection', async () => {
  const { api, fetcher } = setup(response(200, { user: alice }), response(200, { conversationId: 'chat', version: 0, items: [] }), response(200, { user: alice }),
    response(200, { user: alice }), response(200, proof), response(200, { pinned: true }), response(200, { user: alice }));
  await api.request('/api/conversations/chat/pins');
  const body = { pinned: true, expectedVersion: 0, operationId: '00000000-0000-4000-8000-000000000000' };
  await api.request('/api/messages/storage-id/pin', { method: 'POST', body });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/auth/me', '/api/conversations/chat/pins', '/api/auth/me', '/api/auth/me', '/api/auth/csrf', '/api/messages/storage-id/pin', '/api/auth/me']);
  expect(fetcher.mock.calls[5]?.[1]).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', headers: { 'X-CSRF-Token': proof.csrfToken }, body: JSON.stringify(body) });
  api.dispose();
});

test('reaction routes retain identity checks and authenticated CSRF writes',async()=>{
  const {api,fetcher}=setup(response(200,{user:alice}),response(200,{items:[]}),response(200,{user:alice}),response(200,{user:alice}),response(200,proof),response(200,{emoji:'👍'}),response(200,{user:alice}));
  await api.request('/api/conversations/chat/reactions?ids=first%2Csecond');await api.request('/api/messages/storage-id/reaction',{method:'POST',body:{emoji:'👍',expectedRevision:0,operationId:'test'}});
  expect(fetcher.mock.calls[5]?.[1]).toMatchObject({credentials:'same-origin',headers:{'X-CSRF-Token':proof.csrfToken}});api.dispose();
});

test.each(['/api/messages/storage-id/pin/extra', '/api/conversations/chat/pins/extra', '/api/messages/storage-id/pins'])('pin allowlist rejects unintended routes: %s', async path => {
  const { api, fetcher } = setup(); await expect(api.request(path)).rejects.toMatchObject({ code: 'unavailable' }); expect(fetcher).not.toHaveBeenCalled(); api.dispose();
});

test.each(['/api/attachments','/api/attachments/file-id/download','/api/files'])('unintegrated binary routes cannot use the JSON authenticated messaging transport: %s',async path=>{
  const {api,fetcher}=setup();await expect(api.request(path)).rejects.toMatchObject({code:'unavailable'});expect(fetcher).not.toHaveBeenCalled();api.dispose();
});

test.each([['https://evil.test/api/users/me'], ['//evil.test/api/users/me'], ['/api/auth/login'], ['/api/users/../blocks']])(
  'rejects paths outside the same-origin social scope: %s', async path => {
    const { api, fetcher } = setup();
    await expect(api.request(path!)).rejects.toMatchObject({ code: 'unavailable' }); expect(fetcher).not.toHaveBeenCalled(); api.dispose();
  });

test('a switched cookie identity invalidates the provider without reading the previous actor’s data', async () => {
  const { api, service, fetcher } = setup(response(200, { user: bob })); const invalidate = jest.fn(); service.subscribeToInvalidation(invalidate);
  await expect(api.request('/api/users/me')).rejects.toBeInstanceOf(ApiError);
  expect(invalidate).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(api.request('/api/friends')).rejects.toMatchObject({ code: 'cancelled' }); api.dispose();
});

test('a changed actor after a read discards the entire result', async () => {
  const { api, service } = setup(response(200, { user: alice }), response(200, { private: 'old account' }), response(200, { user: bob }));
  const invalidated = jest.fn(); service.subscribeToInvalidation(invalidated);
  await expect(api.request('/api/users/me')).rejects.toBeInstanceOf(ApiError); expect(invalidated).toHaveBeenCalledTimes(1); api.dispose();
});

test('disposal rejects a fetch which ignores AbortSignal and prevents its late completion', async () => {
  const { api, fetcher } = setup(response(200, { user: alice }));
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(async () => response(200, { user: alice })).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = api.request('/api/friends');
  // Flush the identity guard before the data fetch.
  for (let i = 0; i < 8 && !resolve; i += 1) await Promise.resolve();
  api.dispose(); await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  resolve?.(response(200, { items: ['must not publish'] }));
});

test.each([[403, { code: 'CSRF_INVALID', message: 'secret diagnostics' }, 'csrf_invalid'],
  [403, { code: 'ORIGIN_INVALID' }, 'forbidden'], [404, {}, 'not_found'], [409, { code: 'STALE_STATE' }, 'stale_state'],
  [409, {}, 'conflict'], [400, { fields: ['displayName', 'password', 'email'] }, 'validation'],
  [503, { message: 'database password' }, 'service_unavailable'], [429, {}, 'rate_limited']])(
  'maps status %s to a fixed safe message without retrying writes', async (status, body, code) => {
    const { api, fetcher } = setup(response(200, { user: alice }), response(200, proof), response(status as number, body, '17'));
    const error = await api.request('/api/users/me', { method: 'PATCH', body: { displayName: 'Alice' } }).catch(failure => failure);
    if (!(error instanceof ApiError)) throw new Error('Expected a safe API error');
    expect(error).toMatchObject({ code }); expect(error.message).not.toMatch(/secret diagnostics|database password/);
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/users/me')).toHaveLength(1);
    if (code === 'validation') expect(error.fields).toEqual(['displayName']);
    if (code === 'rate_limited') expect(error.message).toContain('17 seconds'); api.dispose();
  });

test('401 uses the existing authentication invalidation', async () => {
  const { api, service } = setup(response(200, { user: alice }), response(401));
  const invalidated = jest.fn(); service.subscribeToInvalidation(invalidated);
  await expect(api.request('/api/users/me')).rejects.toBeInstanceOf(ApiError); expect(invalidated).toHaveBeenCalledTimes(1); api.dispose();
});

test('logout cancels old scoped reads even before the logout response', async () => {
  const { api, service, fetcher } = setup();
  fetcher.mockResolvedValue(response(200, { user: alice }));
  fetcher.mockImplementationOnce(() => new Promise(() => {}));
  const pending = api.request('/api/friends');
  const logout = service.logout();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' }); await expect(logout).rejects.toBeDefined(); api.dispose();
});

test('a reachable older backend with DB-2 and no DB-3 is a feature error, not a connection failure', async () => {
  const { api, fetcher } = setup(response(200, { user: alice }), response(503, { code: 'FEATURE_UNAVAILABLE', fields: [], diagnostic: 'private backend detail' }));
  const error = await api.request('/api/users/me').catch(failure => failure);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: 'feature_unavailable' });
  expect((error as ApiError).message).toContain('not enabled on the connected service');
  expect((error as ApiError).message).not.toMatch(/could not be reached|private backend detail/);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/auth/me', '/api/users/me']); api.dispose();
});

test('an explicit profile retry sends a fresh request and recovers with the same valid session', async () => {
  const profile = { ...alice, statusMessage: '', presencePreference: 'available' };
  const { api, fetcher } = setup(response(200, { user: alice }), response(503, { code: 'FEATURE_UNAVAILABLE' }),
    response(200, { user: alice }), response(200, { profile }), response(200, { user: alice }));
  await expect(api.request('/api/users/me')).rejects.toMatchObject({ code: 'feature_unavailable' });
  await expect(api.request('/api/users/me')).resolves.toEqual({ profile });
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/users/me')).toHaveLength(2); api.dispose();
});

test.each([[403, { code: 'FORBIDDEN' }, 'forbidden'], [404, {}, 'not_found'],
  [429, {}, 'rate_limited'], [500, {}, 'service_unavailable'], [503, { code: 'FEATURE_UNAVAILABLE' }, 'feature_unavailable']])(
  'session-check HTTP %s retains its meaning rather than becoming a network error', async (status, body, code) => {
    const { api, fetcher } = setup(response(status as number, body));
    await expect(api.request('/api/users/me')).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1); api.dispose();
  });

test('a genuine transport failure retains connection-error guidance', async () => {
  const { api, fetcher } = setup(response(200, { user: alice })); fetcher.mockRejectedValueOnce(new TypeError('private transport diagnostics'));
  const error = await api.request('/api/users/me').catch(failure => failure);
  expect(error).toMatchObject({ code: 'unavailable' }); expect((error as ApiError).message).toContain('could not be reached');
  expect((error as ApiError).message).not.toContain('private transport diagnostics'); api.dispose();
});

test.each(['identity', 'profile'])('malformed successful %s JSON is an invalid response, not a network failure', async location => {
  const broken = { status: 200, json: async () => { throw new SyntaxError('private response body'); }, headers: { get: () => null } } as unknown as Response;
  const { api } = location === 'identity' ? setup(broken) : setup(response(200, { user: alice }), broken);
  await expect(api.request('/api/users/me')).rejects.toMatchObject({ code: 'invalid_response' }); api.dispose();
});

test('non-JSON proxy failure remains a service error and is never rendered as raw HTML', async () => {
  const proxy = { status: 502, json: async () => { throw new SyntaxError('<html>private proxy diagnostic</html>'); }, headers: { get: () => null } } as unknown as Response;
  const { api } = setup(response(200, { user: alice }), proxy);
  const error = await api.request('/api/users/me').catch(failure => failure);
  expect(error).toMatchObject({ code: 'service_unavailable' }); expect((error as ApiError).message).not.toContain('private proxy'); api.dispose();
});
