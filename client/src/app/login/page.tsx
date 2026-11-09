'use client';

import { AuthOnlyRoute } from '@/auth/AuthRouteGuards';
import { AuthForm } from '@/components/auth/AuthForm';

export default function LoginPage() {
  return <AuthOnlyRoute><AuthForm variant="login" /></AuthOnlyRoute>;
}
