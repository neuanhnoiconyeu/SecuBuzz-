'use client';

import { useEffect, useState } from 'react';
import type { AuthUser } from '@/auth/authModel';
import { useAuth } from '@/auth/AuthProvider';
import { useDirectCalls } from '@/components/calls/DirectCallsRuntime';
import { AuthShell } from '@/components/auth/AuthShell';
import { ProfileAvatar } from '@/components/profile/ProfileAvatar';
import { Button } from '@/components/ui';
import { DirectCallActions } from '@/components/calls/DirectCallActions';
import { isCallFinished } from '@/calls/directCallMachine';

interface Context { conversationId: string; peer: { id: string; name: string }; }
type MediaStatus = 'checking' | 'available' | 'disabled' | 'unconfigured' | 'unavailable';

/** Resolve the fixed target through the authenticated backend; reuse the workspace's single call runtime. */
export function DevelopmentCallingWorkspace({ user }: { user: AuthUser }) {
  const auth = useAuth();
  const calls = useDirectCalls();
  const [context, setContext] = useState<Context | null>(null);
  const [status, setStatus] = useState<MediaStatus>('checking');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let active = true;
    setStatus('checking'); setContext(null); setError(null);
    const options: RequestInit = { signal: controller.signal, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' };
    void (async () => {
      const [targetResponse, statusResponse] = await Promise.all([
        fetch('/api/dev-calling/context', options), fetch('/api/dev-calling/status', options),
      ]);
      if (!targetResponse.ok || !statusResponse.ok) throw new Error();
      const target = await targetResponse.json();
      const health = await statusResponse.json();
      if (target.developmentOnly !== true || target.user?.id !== user.id || target.conversation?.type !== 'direct' ||
          typeof target.conversation.id !== 'string' || typeof target.peer?.id !== 'string' || target.peer.id === user.id ||
          typeof target.peer?.displayName !== 'string' || !Array.isArray(target.conversation.participants) ||
          target.conversation.participants.length !== 2 || ![user.id, target.peer.id].every(id => target.conversation.participants.some((person: { id: string }) => person.id === id)) ||
          health.developmentOnly !== true || !['available', 'disabled', 'unconfigured', 'unavailable'].includes(health.livekit)) throw new Error();
      if (active) {
        setContext({ conversationId: target.conversation.id, peer: { id: target.peer.id, name: target.peer.displayName } });
        setStatus(health.livekit);
      }
    })().catch(() => { if (active) { setStatus('unavailable'); setError('The development calling backend could not be reached. Check its configuration and retry.'); } })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [user.id, attempt]);
  const ready = status === 'available' && Boolean(context);
  const signaling = calls?.signalStatus === 'connected' ? 'Ready' : calls?.signalStatus ?? 'Initializing';
  return <AuthShell><section className="auth-card" aria-labelledby="development-calling-title">
    <p className="auth-eyebrow">LOCAL DEVELOPMENT · API MODE</p>
    <h1 id="development-calling-title" className="auth-heading display-heading">Calling workspace</h1>
    <p>Signed in as {user.displayName}</p>
    <p className="auth-description">Use separate browser profiles for Alice and Bob. Accept an invitation to start microphone capture; video calls also request the camera.</p>
    <dl className="development-call-readiness" aria-label="Calling service readiness">
      <div><dt>LiveKit API</dt><dd role="status">{status}</dd></div>
      <div><dt>Signaling</dt><dd>{signaling}</dd></div>
    </dl>
    {context && <><ProfileAvatar displayName={context.peer.name} avatar="initials" size="lg" /><p>{context.peer.name}</p></>}
    {status !== 'available' && status !== 'checking' && <p className="auth-feedback">Live media is unavailable. Configure or start LiveKit, then retry.</p>}
    {error && <p role="alert" className="auth-feedback auth-feedback--error">{error}</p>}
    {calls?.media.connectionError && <p role="alert" className="auth-feedback auth-feedback--error">{calls.media.connectionError}</p>}
    {status === 'available' && !calls?.available && !calls?.media.connectionError && <p role="status">Waiting for authenticated signaling and frontend media configuration.</p>}
    {context && <DirectCallActions name={context.peer.name} target={context} disabled={!ready} />}
    {calls && isCallFinished(calls.state) && <p className="auth-description">Close the finished call panel to place another call.</p>}
    <Button variant="outline" disabled={status === 'checking'} onClick={() => setAttempt(value => value + 1)}>Retry service check</Button>
    <Button disabled={Boolean(auth.pending)} onClick={() => void auth.logout()}>Sign Out</Button>
    {auth.error && <p role="alert">{auth.error.message}</p>}
  </section></AuthShell>;
}
