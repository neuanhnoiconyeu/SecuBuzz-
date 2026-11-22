import { messagingProxyRewrites } from '../../../authProxy.cjs';
test('key/conversation/message rewrites expose only explicit DATA contracts in static-first order', () => {
  const routes = messagingProxyRewrites({ NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5119' });
  expect(routes).toHaveLength(21); expect(routes.map((r: { source: string }) => r.source)).toEqual(expect.arrayContaining(['/api/conversations/:id/keys/epochs/:keyId', '/api/conversations/:id/pins', '/api/messages/:id/pin','/api/conversations/:id/reactions','/api/messages/:id/reaction','/api/attachments/:id/download','/api/attachments/batches/:cid/:mid','/api/calls/token']));
  for (const route of routes) { expect(route.destination).toBe('http://127.0.0.1:5119' + route.source); expect(route.source).not.toMatch(/\*|logs|contacts|internal/); }
  expect(messagingProxyRewrites({ NODE_ENV: 'production' })).toEqual([]);
  expect(() => messagingProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'http://127.0.0.1:5119' })).toThrow();
});
