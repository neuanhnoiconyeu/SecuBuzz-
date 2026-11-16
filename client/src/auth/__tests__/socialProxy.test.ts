import { socialProxyRewrites } from '../../../authProxy.cjs';
test('social proxy exposes only DB-3 paths and preserves static route precedence', () => {
  const rewrites = socialProxyRewrites({ NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5118' });
  expect(rewrites).toHaveLength(11);
  expect(rewrites.slice(0, 3).map((route: { source: string }) => route.source)).toEqual(['/api/users/search', '/api/users/me', '/api/users/:id']);
  for (const route of rewrites) expect(route.destination).toBe(`http://127.0.0.1:5118${route.source}`);
  expect(rewrites.some((route: { source: string }) => /messages|contacts|logs|path\*/.test(route.source))).toBe(false);
});
test('production social proxy shares the existing HTTPS target validation', () => {
  expect(socialProxyRewrites({ NODE_ENV: 'production' })).toEqual([]);
  expect(() => socialProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'http://127.0.0.1:5118' })).toThrow();
  expect(socialProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'https://data.example.test' })[0].destination).toBe('https://data.example.test/api/users/search');
});
