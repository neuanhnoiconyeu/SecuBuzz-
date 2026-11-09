'use client';

import { AuthOnlyRoute } from '@/auth/AuthRouteGuards';
import { AuthForm } from '@/components/auth/AuthForm';

export default function SignupPage() {
  return <AuthOnlyRoute><AuthForm variant="signup" /></AuthOnlyRoute>;
}
