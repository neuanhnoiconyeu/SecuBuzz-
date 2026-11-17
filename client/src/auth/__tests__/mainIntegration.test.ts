import { createConfiguredAuthService } from '../authService';
import { DevelopmentCallingHttpAuthService } from '@/dev/calling/httpAuthService';

afterEach(() => jest.restoreAllMocks());

test('production retains DATA session APIs even when development calling flags are present', () => {
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production', NEXT_PUBLIC_AUTH_MODE: 'api',
    NEXT_PUBLIC_AUTH_API_READY: 'true', NEXT_PUBLIC_DEV_CALLS_ENABLED: 'true' });
  const service = createConfiguredAuthService();
  expect(service.constructor.name).toBe('HttpAuthService');
  expect(service.createSessionApi).toEqual(expect.any(Function));
  expect(() => new DevelopmentCallingHttpAuthService({ getCsrfToken: () => 'x' })).toThrow();
});

test('the retained main adapter requires the explicit development opt-in and cannot bypass disabled auth', () => {
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development', NEXT_PUBLIC_AUTH_MODE: 'api',
    NEXT_PUBLIC_AUTH_API_READY: 'true', NEXT_PUBLIC_DEV_CALLS_ENABLED: 'false' });
  expect(() => new DevelopmentCallingHttpAuthService({ getCsrfToken: () => 'x' })).toThrow();
  expect(createConfiguredAuthService().createSessionApi).toEqual(expect.any(Function));
  process.env.NEXT_PUBLIC_DEV_CALLS_ENABLED = 'true';
  expect(createConfiguredAuthService().createSessionApi).toBeUndefined();
  process.env.NEXT_PUBLIC_AUTH_API_READY = 'false';
  expect(createConfiguredAuthService().mode).toBe('unconfigured');
});
