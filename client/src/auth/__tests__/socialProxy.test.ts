import { socialProxyRewrites } from '../../../authProxy.cjs';
test('social proxy exposes only DB-3 and avatar paths in static-first precedence', () => {
  const expectedSources = [
    '/api/users/search',
    '/api/users/me/avatar',
    '/api/users/me',
    '/api/users/:id/avatar',
    '/api/users/:id',
    '/api/friends/requests/:id/accept',
    '/api/friends/requests/:id/decline',
    '/api/friends/requests/:id',
    '/api/friends/requests',
    '/api/friends/:id',
    '/api/friends',
    '/api/blocks/:userId',
    '/api/blocks',
  ];
  const rewrites = socialProxyRewrites({ NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5118' });
  expect(rewrites).toHaveLength(expectedSources.length);
  const sources = rewrites.map((route: { source: string }) => route.source);
  expect(sources).toEqual(expectedSources);
  expect(sources.indexOf('/api/users/me/avatar')).toBeLessThan(sources.indexOf('/api/users/:id/avatar'));
  expect(sources.indexOf('/api/users/:id/avatar')).toBeLessThan(sources.indexOf('/api/users/:id'));
  for (const route of rewrites) {
    expect(Object.keys(route).sort()).toEqual(['destination', 'source']);
    expect(route.destination).toBe(`http://127.0.0.1:5118${route.source}`);
  }
  expect(rewrites.some((route: { source: string }) => /messages|contacts|logs|internal|path\*|\*/.test(route.source))).toBe(false);
});
test('production social proxy shares the existing HTTPS target validation', () => {
  expect(socialProxyRewrites({ NODE_ENV: 'production' })).toEqual([]);
  expect(() => socialProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'http://127.0.0.1:5118' })).toThrow();
  expect(socialProxyRewrites({ NODE_ENV: 'production', AUTH_BACKEND_URL: 'https://data.example.test' })[0].destination).toBe('https://data.example.test/api/users/search');
});
