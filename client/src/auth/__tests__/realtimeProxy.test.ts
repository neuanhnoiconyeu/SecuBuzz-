import { realtimeProxyRewrites } from '../../../authProxy.cjs';
test('realtime endpoint preserves the Engine.IO slash and uses the same server as REST', () => {
  expect(realtimeProxyRewrites({ NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5177' })).toEqual([
    { source: '/socket.io', destination: 'http://127.0.0.1:5177/socket.io/' },
  ]);
});
test('production requires configured HTTPS', () => {
  expect(realtimeProxyRewrites({ NODE_ENV: 'production' })).toEqual([]);
  expect(realtimeProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'https://data.example.test' })[0]?.destination).toBe('https://data.example.test/socket.io/');
});
test.each(['http://public.example.test', 'https://user:secret@data.example.test', 'https://data.example.test?token=secret', 'https://data.example.test/other'])('rejects unsafe backend %s', target => {
  expect(() => realtimeProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: target })).toThrow();
});
