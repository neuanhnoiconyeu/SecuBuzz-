'use client';

import { RequireAuth } from '@/auth/AuthRouteGuards';
import { AuthenticatedWorkspace } from '@/auth/AuthenticatedWorkspace';

export default function Home() {
  return <RequireAuth><AuthenticatedWorkspace /></RequireAuth>;
}
