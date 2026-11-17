import { authProxyRewrites } from '../../../authProxy.cjs';

test('only the five auth operations are proxied, keeping same-origin browser paths and no header overrides', () => {
  const routes = authProxyRewrites({NODE_ENV:'development',AUTH_BACKEND_URL:'http://127.0.0.1:5000'});
  expect(routes).toHaveLength(5);
  expect(routes.map(route=>route.source)).toEqual(['csrf','register','login','me','logout'].map(name=>`/api/auth/${name}`));
  for (const route of routes) {
    expect(Object.keys(route).sort()).toEqual(['destination','source']);
    expect(route.destination).toBe(`http://127.0.0.1:5000${route.source}`);
  }
});
test('an absent production target leaves routing to the deployment owner; HTTPS is accepted', () => {
  expect(authProxyRewrites({NODE_ENV:'production'})).toEqual([]);
  expect(authProxyRewrites({NODE_ENV:'production',AUTH_BACKEND_URL:'https://api.example.test'})).toHaveLength(5);
});
test.each(['http://api.example.test','https://user:password@api.example.test','https://api.example.test?key=x',
  'https://api.example.test/#x','https://api.example.test/path','not a URL'])('refuses unsafe proxy target %s', target => {
  expect(()=>authProxyRewrites({NODE_ENV:'development',AUTH_BACKEND_URL:target})).toThrow();
});
test('production refuses the development HTTP exception and unsafe public base paths', () => {
  expect(()=>authProxyRewrites({NODE_ENV:'production',AUTH_BACKEND_URL:'http://127.0.0.1:5000'})).toThrow();
  expect(()=>authProxyRewrites({NODE_ENV:'development',NEXT_PUBLIC_AUTH_API_BASE_PATH:'//evil.test'})).toThrow();
});
