import { startDevelopmentCallingHarness } from './server.ts';

startDevelopmentCallingHarness(process.env).then(harness => {
  console.log(JSON.stringify({ developmentOnly: true, url: harness.url, mediaConfigured: harness.mediaConfigured,
    message: 'Local calling harness only. Database and Security services are not connected.' }));
  const stop = () => { void harness.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}).catch(() => {
  console.error('Development calling harness refused startup. Check development opt-in, loopback origin, port, and both development passwords.');
  process.exitCode = 1;
});
