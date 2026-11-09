'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AuthLoading } from '@/components/auth/AuthShell';
import { useAuth } from './AuthProvider';
import { safeReturnTo } from './authNavigation';

/** Client route guards are presentation controls; API authorization remains server-owned. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const redirected = useRef(false);
  useEffect(() => {
    if (auth.status !== 'unauthenticated') { redirected.current = false; return; }
    if (redirected.current) return;
    redirected.current = true;
    const destination = safeReturnTo(window.location.pathname + window.location.hash);
    router.replace(`/login?next=${encodeURIComponent(destination)}`);
  }, [auth.status, router]);
  if (auth.status !== 'authenticated' || !auth.user) return <AuthLoading message={auth.status === 'initializing' ? 'Restoring your session…' : 'Opening sign in…'} />;
  return <>{children}</>;
}

export function AuthOnlyRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const redirected = useRef(false);
  useEffect(() => {
    if (auth.status !== 'authenticated') { redirected.current = false; return; }
    if (redirected.current) return;
    redirected.current = true;
    router.replace(safeReturnTo(new URLSearchParams(window.location.search).get('next')));
  }, [auth.status, router]);
  if (auth.status !== 'unauthenticated') return <AuthLoading message={auth.status === 'initializing' ? 'Restoring your session…' : 'Opening Messenger…'} />;
  return <>{children}</>;
}
