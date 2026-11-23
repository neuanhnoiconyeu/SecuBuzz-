const original = { enabled: process.env.NEXT_PUBLIC_LIVEKIT_ENABLED, url: process.env.NEXT_PUBLIC_LIVEKIT_URL, direct: process.env.NEXT_PUBLIC_DIRECT_CALLS_ENABLED };
afterEach(() => {
  if (original.enabled === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_ENABLED; else process.env.NEXT_PUBLIC_LIVEKIT_ENABLED = original.enabled;
  if (original.url === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_URL; else process.env.NEXT_PUBLIC_LIVEKIT_URL = original.url;
  if (original.direct === undefined) delete process.env.NEXT_PUBLIC_DIRECT_CALLS_ENABLED; else process.env.NEXT_PUBLIC_DIRECT_CALLS_ENABLED = original.direct;
});
test.each([
  [undefined, undefined, false], ['false', 'ws://localhost:7880', false], ['true', undefined, false], ['true', 'ws://localhost:7880', true],
])('real calls require explicit configured media: %s, %s', async (enabled, url, expected) => {
  delete process.env.NEXT_PUBLIC_DIRECT_CALLS_ENABLED;
  if (enabled === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_ENABLED; else process.env.NEXT_PUBLIC_LIVEKIT_ENABLED = enabled as string;
  if (url === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_URL; else process.env.NEXT_PUBLIC_LIVEKIT_URL = url as string;
  await jest.isolateModulesAsync(async () => {
    const { REAL_ACCOUNT_MESSAGING_CAPABILITIES: real, DEMO_MESSAGING_CAPABILITIES: demo } = await import('../messagingCapabilities');
    expect(real.directCalls).toBe(expected); expect(demo.directCalls).toBe(true);
    expect(real.reply && real.forward && real.edit && real.unsendForEveryone && real.pin && real.reactions && real.voiceMessages && real.attachments).toBe(true);
  });
});

test.each(['true', 'false'])('the direct-call override %s preserves the independent Voice Rooms gate', async directFlag => {
  process.env.NEXT_PUBLIC_LIVEKIT_ENABLED = 'false';
  process.env.NEXT_PUBLIC_DIRECT_CALLS_ENABLED = directFlag;
  process.env.NEXT_PUBLIC_LIVEKIT_URL = 'ws://localhost:7880';
  await jest.isolateModulesAsync(async () => {
    const { REAL_ACCOUNT_MESSAGING_CAPABILITIES: real } = await import('../messagingCapabilities');
    const { createSessionLiveKitConnection } = await import('@/voice/livekitConnection');
    const { voiceUser } = await import('@/test-support/liveVoiceFixture');
    const room = createSessionLiveKitConnection(voiceUser, 'api');
    const call = createSessionLiveKitConnection(voiceUser, 'api', undefined, 'direct-call');
    expect(real.directCalls).toBe(directFlag === 'true');
    expect(room.getSnapshot().status).toBe('disabled');
    expect(call.getSnapshot().status).toBe(directFlag === 'true' ? 'disconnected' : 'disabled');
    await room.dispose(); await call.dispose();
  });
});
