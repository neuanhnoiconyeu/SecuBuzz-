import { createSessionRealtimeClient } from '../createRealtimeClient';
import { MockRealtimeClient } from '../MockRealtimeClient';
import { SocketIoRealtimeClient } from '../SocketIoRealtimeClient';
import { createDemoProfile } from '@/profiles/profileModel';
import { createDemoConversations } from '@/conversations/demoConversations';

const originalEnv = process.env;
const demo = createDemoProfile();
const real = { ...demo, id: 'account-123', isDemo: false };
beforeEach(() => { process.env = { ...originalEnv, NODE_ENV: 'test', NEXT_PUBLIC_REALTIME_CONTRACT_READY: 'false' }; delete process.env.NEXT_PUBLIC_REALTIME_URL; });
afterEach(() => { process.env = originalEnv; });

test('only a development demo identity selects the mock', () => {
  const client = createSessionRealtimeClient(demo, 'demo', createDemoConversations());
  expect(client).toBeInstanceOf(MockRealtimeClient); client.dispose();
  expect(() => createSessionRealtimeClient(real, 'demo', [])).toThrow();
  expect(() => createSessionRealtimeClient(demo, 'api', [])).toThrow();
});

test('production cannot activate mocks, including an explicitly enabled demo flag', () => {
  process.env = { ...process.env, NODE_ENV: 'production', NEXT_PUBLIC_AUTH_MODE: 'demo', NEXT_PUBLIC_REALTIME_CONTRACT_READY: 'true', NEXT_PUBLIC_REALTIME_URL: 'https://realtime.example.test' };
  expect(() => createSessionRealtimeClient(demo, 'demo', [])).toThrow();
  expect(() => createSessionRealtimeClient(demo, 'api', [])).toThrow();
});

test('missing API configuration fails closed rather than returning fixtures', () => {
  expect(() => createSessionRealtimeClient(real, 'api', [])).toThrow();
  process.env.NEXT_PUBLIC_REALTIME_CONTRACT_READY = 'true';
  expect(() => createSessionRealtimeClient(real, 'api', [])).toThrow();
  process.env.NEXT_PUBLIC_REALTIME_URL = 'http://remote.example.test';
  expect(() => createSessionRealtimeClient(real, 'api', [])).toThrow();
});

test('an explicitly configured real API identity obtains a disconnected Socket adapter with sends disabled', () => {
  process.env.NEXT_PUBLIC_REALTIME_CONTRACT_READY = 'true';
  process.env.NEXT_PUBLIC_REALTIME_URL = 'https://realtime.example.test';
  const client = createSessionRealtimeClient(real, 'api', []);
  expect(client).toBeInstanceOf(SocketIoRealtimeClient);
  expect(client.getStatus()).toBe('disconnected'); expect(client.canSendMessages).toBe(false);
  client.dispose();
});
