// Importing this development package in production is forbidden, even before startup.
if (process.env.NODE_ENV === 'production') throw new Error('Development calling harness refuses production.');

export interface DevelopmentCallingConfig {
  readonly port: number;
  readonly appOrigin: string;
  readonly alicePassword: string;
  readonly bobPassword: string;
}
export function loadDevelopmentCallingConfig(env: NodeJS.ProcessEnv): DevelopmentCallingConfig {
  if (env.NODE_ENV !== 'development' || env.SECUBUZZ_DEV_CALLS_ENABLED !== 'true') {
    throw new Error('Calling harness requires NODE_ENV=development and SECUBUZZ_DEV_CALLS_ENABLED=true.');
  }
  if (env.DEV_CALLS_HOST !== undefined && env.DEV_CALLS_HOST !== '127.0.0.1') throw new Error('Calling harness only binds to 127.0.0.1.');
  const port = Number(env.DEV_CALLS_PORT ?? '5101');
  if (!/^\d{1,5}$/.test(env.DEV_CALLS_PORT ?? '5101') || port < 0 || port > 65535) throw new Error('Invalid DEV_CALLS_PORT.');
  const appOrigin = env.DEV_CALLS_APP_ORIGIN ?? 'http://localhost:3000';
  let origin: URL;
  try { origin = new URL(appOrigin); } catch { throw new Error('Invalid DEV_CALLS_APP_ORIGIN.'); }
  if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.origin !== appOrigin || origin.username || origin.password) throw new Error('DEV_CALLS_APP_ORIGIN must be an exact loopback origin.');
  const alicePassword = env.DEV_CALLS_ALICE_PASSWORD ?? '', bobPassword = env.DEV_CALLS_BOB_PASSWORD ?? '';
  if (alicePassword.length < 12 || bobPassword.length < 12 || alicePassword === bobPassword) throw new Error('Set distinct development passwords of at least 12 characters for Alice and Bob.');
  return { port, appOrigin, alicePassword, bobPassword };
}
