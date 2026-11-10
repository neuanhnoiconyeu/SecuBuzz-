'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, UserRound } from 'lucide-react';
import { Button, TextInput } from '@/components/ui';
import { useAuth } from '@/auth/AuthProvider';
import { useSafeReturnTo } from '@/auth/authNavigation';
import { validateLogin, validateRegistration } from '@/auth/authModel';
import type { AuthField, AuthFieldErrors } from '@/auth/authModel';
import { AuthShell } from './AuthShell';
import { PasswordField } from './PasswordField';

export interface AuthFormProps { variant: 'login' | 'signup' }

const initialFields = { identifier: '', username: '', email: '', password: '', confirmPassword: '' };

export function AuthForm({ variant }: AuthFormProps) {
  const auth = useAuth();
  const router = useRouter();
  const returnTo = useSafeReturnTo();
  const [fields, setFields] = useState(initialFields);
  const [errors, setErrors] = useState<AuthFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);
  const [submitting, setSubmitting] = useState<'login' | 'signup' | 'explorer' | 'nova' | null>(null);
  const submitLock = useRef(false);
  const fieldRefs = useRef<Partial<Record<AuthField, HTMLInputElement | null>>>({});
  const attempted = useRef(false);
  const busy = Boolean(auth.pending || submitting);
  const unavailable = auth.mode === 'unconfigured';
  const disabled = busy || unavailable;
  const signup = variant === 'signup';

  useEffect(() => {
    if (variant === 'login') setRegistered(new URLSearchParams(window.location.search).get('registered') === '1');
  }, [variant]);

  const focusFirstError = (fieldErrors: AuthFieldErrors) => {
    const order: AuthField[] = signup ? ['username', 'email', 'password', 'confirmPassword'] : ['identifier', 'password'];
    const field = order.find((candidate) => fieldErrors[candidate]);
    if (field) fieldRefs.current[field]?.focus();
  };

  useEffect(() => {
    if (busy || !attempted.current || !auth.error || !Object.keys(auth.error.fieldErrors).length) return;
    setErrors(auth.error.fieldErrors);
    const order: AuthField[] = variant === 'signup' ? ['username', 'email', 'password', 'confirmPassword'] : ['identifier', 'password'];
    const field = order.find((candidate) => auth.error?.fieldErrors[candidate]);
    if (field) fieldRefs.current[field]?.focus();
  }, [auth.error, busy, variant]);

  const change = (field: keyof typeof initialFields, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => { const next = { ...current }; delete next[field]; return next; });
    setFormError(null);
    auth.clearError();
  };

  const clearPasswords = () => setFields((current) => ({ ...current, password: '', confirmPassword: '' }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitLock.current || disabled) return;
    auth.clearError();
    setFormError(null);
    attempted.current = true;
    if (signup) {
      const validation = validateRegistration({
        username: fields.username, email: fields.email, password: fields.password, confirmPassword: fields.confirmPassword,
      });
      if (!validation.valid) {
        setErrors(validation.errors);
        setFormError('Please check the highlighted fields.');
        focusFirstError(validation.errors);
        return;
      }
      submitLock.current = true;
      setSubmitting('signup');
      setErrors({});
      try {
        const result = await auth.register(validation.value);
        if (!result) setFormError('Your account could not be created. Please try again.');
        else if (result.status === 'requires-login') {
          router.replace(`/login?registered=1&next=${encodeURIComponent(returnTo)}`);
        }
        // AuthOnlyRoute owns the one successful authenticated redirect.
      } catch {
        setFormError('Your account could not be created. Please try again.');
      } finally {
        clearPasswords();
        submitLock.current = false;
        setSubmitting(null);
      }
      return;
    }

    const validation = validateLogin({ identifier: fields.identifier, password: fields.password });
    if (!validation.valid) {
      setErrors(validation.errors);
      setFormError('Please check the highlighted fields.');
      focusFirstError(validation.errors);
      return;
    }
    submitLock.current = true;
    setSubmitting('login');
    setErrors({});
    try {
      if (!await auth.login(validation.value)) setFormError('Sign-in could not be completed. Please try again.');
    } catch {
      setFormError('Sign-in could not be completed. Please try again.');
    } finally {
      clearPasswords();
      submitLock.current = false;
      setSubmitting(null);
    }
  };

  const continueDemo = async (persona: 'explorer' | 'nova') => {
    if (submitLock.current || busy || auth.mode !== 'demo') return;
    attempted.current = true;
    submitLock.current = true;
    setSubmitting(persona);
    setErrors({});
    setFormError(null);
    auth.clearError();
    try {
      if (!await auth.continueAsDemo(persona)) setFormError('The demo could not be opened. Please try again.');
    } catch {
      setFormError('The demo could not be opened. Please try again.');
    } finally {
      clearPasswords();
      submitLock.current = false;
      setSubmitting(null);
    }
  };

  const errorMessage = auth.error?.message || formError;

  return (
    <AuthShell>
      <section className="auth-card" aria-labelledby="auth-form-title">
        <p className="auth-eyebrow">{signup ? 'A NEW CONNECTION STARTS HERE' : 'PICK UP WHERE YOU LEFT OFF'}</p>
        <h1 id="auth-form-title" className="auth-heading display-heading">{signup ? 'JOIN SECU BUZZ!' : 'WELCOME BACK!'}</h1>
        <p className="auth-description">{signup ? 'Create your account and start connecting.' : 'Your conversations are waiting.'}</p>

        {auth.mode === 'demo' && <div className="auth-demo-notice">
          <strong>Development demo</strong>
          <p>Use sample values, never a real password. Credentials are not verified and no real account is created.</p>
          <p>Temporary demo sessions stay in memory and end on refresh.</p>
        </div>}
        {unavailable && <div className="auth-feedback" role="status">
          <strong>Sign-in is not connected yet.</strong> This build has no authentication service configured.
          {' '}The backend must be connected before you can sign in or create an account.
        </div>}
        {registered && !signup && <p className="auth-feedback auth-feedback--success" role="status">Account created. Sign in to continue.</p>}
        {errorMessage && <p className="auth-feedback auth-feedback--error" role="alert">{errorMessage}</p>}

        <form className="auth-form" method="post" aria-label={signup ? 'Create account' : 'Sign in'} aria-busy={busy} noValidate onSubmit={(event) => void submit(event)}>
          {signup ? <>
            <TextInput id="auth-username" ref={(node) => { fieldRefs.current.username = node; }} label="Username"
              value={fields.username} onChange={(event) => change('username', event.target.value)} autoComplete="username"
              autoCapitalize="none" spellCheck={false} required disabled={disabled} placeholder="Choose a username"
              hint="3–30 letters, numbers, periods, underscores, or hyphens."
              {...(errors.username ? { error: errors.username } : {})} />
            <TextInput id="auth-email" ref={(node) => { fieldRefs.current.email = node; }} label="Email" type="email"
              value={fields.email} onChange={(event) => change('email', event.target.value)} autoComplete="email"
              autoCapitalize="none" spellCheck={false} inputMode="email" required disabled={disabled} placeholder="you@example.com"
              {...(errors.email ? { error: errors.email } : {})} />
          </> : <TextInput id="auth-identifier" ref={(node) => { fieldRefs.current.identifier = node; }} label="Username or email"
            value={fields.identifier} onChange={(event) => change('identifier', event.target.value)} autoComplete="username"
            autoCapitalize="none" spellCheck={false} required disabled={disabled} placeholder="Enter your username or email"
            {...(errors.identifier ? { error: errors.identifier } : {})} />}

          <PasswordField id="auth-password" ref={(node) => { fieldRefs.current.password = node; }} label="Password"
            value={fields.password} onChange={(event) => change('password', event.target.value)}
            autoComplete={signup ? 'new-password' : 'current-password'} required disabled={disabled} placeholder="Enter your password"
            {...(errors.password ? { error: errors.password } : {})} />
          {signup && <PasswordField id="auth-confirm-password" ref={(node) => { fieldRefs.current.confirmPassword = node; }} label="Confirm password"
            value={fields.confirmPassword} onChange={(event) => change('confirmPassword', event.target.value)}
            autoComplete="new-password" required disabled={disabled} placeholder="Enter your password again"
            {...(errors.confirmPassword ? { error: errors.confirmPassword } : {})} />}
          <Button type="submit" className="auth-submit" disabled={disabled} loading={submitting === variant}
            trailingIcon={<ArrowRight size={17} aria-hidden="true" />}>{signup ? 'Create Account' : 'Sign In'}</Button>
        </form>

        {auth.mode === 'demo' && <div className="auth-demo-actions">
          <p>Or explore without entering credentials</p>
          <Button variant="secondary" disabled={busy} loading={submitting === 'explorer'}
            leadingIcon={<UserRound size={16} aria-hidden="true" />} onClick={() => void continueDemo('explorer')}>Continue as Demo User</Button>
          <Button variant="outline" disabled={busy} loading={submitting === 'nova'}
            onClick={() => void continueDemo('nova')}>Try Nova Demo User</Button>
        </div>}
        <p className="auth-switch">{signup ? 'Already have an account? ' : 'New around here? '}
          <Link href={`${signup ? '/login' : '/signup'}?next=${encodeURIComponent(returnTo)}`}>
            {signup ? 'Sign In' : 'Sign Up'}
          </Link>
        </p>
      </section>
    </AuthShell>
  );
}
