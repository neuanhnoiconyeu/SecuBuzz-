import { useEffect, useState } from 'react';
import { MessengerApp } from '@/components/messenger/MessengerApp';
import { createDemoMessengerSession } from '@/auth/messengerSession';
import { createDemoProfile } from '@/profiles/profileModel';

/** Explicit fixture for Messenger unit tests. Route tests use the real guards/provider. */
export function MessengerHarness() {
  const [session] = useState(() => createDemoMessengerSession(createDemoProfile()));
  useEffect(() => () => session.dispose(), [session]);
  return <MessengerApp session={session} />;
}
