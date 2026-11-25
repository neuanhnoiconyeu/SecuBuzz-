import { messagingProxyRewrites } from '../../../authProxy.cjs';
test('key/conversation/message/preferences/voice rewrites expose only explicit DATA contracts in static-first order', () => {
  const expectedSources = [
    '/api/keys/devices/:deviceId/revoke',
    '/api/keys/devices',
    '/api/conversations/:id/keys/epochs/:keyId',
    '/api/conversations/:id/keys/epochs',
    '/api/conversations/:id/keys',
    '/api/conversations/:id/messages',
    '/api/conversations/:id/pins',
    '/api/conversations/:id/reactions',
    '/api/conversations/:id/preferences',
    '/api/conversations/dm',
    '/api/conversations/:id',
    '/api/conversations',
    '/api/messages/:id/reaction',
    '/api/messages/:id/pin',
    '/api/messages/:id/read',
    '/api/messages/:id',
    '/api/attachments/limits',
    '/api/attachments/batches/:cid/:mid',
    '/api/attachments/:id/download',
    '/api/attachments/:id',
    '/api/attachments',
    '/api/calls/token',
    '/api/voice/token',
    '/api/voice/rooms/:id',
    '/api/voice/rooms',
  ];
  const routes = messagingProxyRewrites({ NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5119' });
  expect(routes).toHaveLength(expectedSources.length);
  const sources = routes.map((r: { source: string }) => r.source);
  expect(sources).toEqual(expectedSources);
  expect(sources.indexOf('/api/conversations/:id/preferences')).toBeLessThan(sources.indexOf('/api/conversations/:id'));
  expect(sources.indexOf('/api/conversations/dm')).toBeLessThan(sources.indexOf('/api/conversations/:id'));
  for (const route of routes) {
    expect(Object.keys(route).sort()).toEqual(['destination', 'source']);
    expect(route.destination).toBe('http://127.0.0.1:5119' + route.source);
    expect(route.source).not.toMatch(/\*|logs|contacts|internal/);
  }
  expect(messagingProxyRewrites({ NODE_ENV: 'production' })).toEqual([]);
  expect(() => messagingProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'http://127.0.0.1:5119' })).toThrow();
});
