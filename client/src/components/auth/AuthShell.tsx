'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, MessageCircle, Palette, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { BrandLogo } from '@/components/branding';
import { AppearanceSelector } from '@/components/appearance/AppearanceSelector';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-window">
        <div className="auth-window-chrome" aria-hidden="true">
          <span>SECU BUZZ / MESSENGER 2.0</span><span>LET&apos;S CONNECT</span>
        </div>
        <header className="auth-header">
          <Link href="/login" className="auth-brand-link" aria-label="Yahoo Security Messenger sign in">
            <BrandLogo variant="compact" size="md" decorative />
          </Link>
          <details className="auth-appearance">
            <summary><Palette size={17} aria-hidden="true" /><span>Appearance</span><ChevronDown size={14} aria-hidden="true" /></summary>
            <div className="auth-appearance-panel"><AppearanceSelector /></div>
          </details>
        </header>
        <div className="auth-layout">
          <section className="auth-brand-panel" aria-labelledby="auth-brand-title">
            <div className="auth-brand-copy">
              <span className="auth-brand-kicker"><Sparkles size={14} aria-hidden="true" />A familiar feeling. A fresh start.</span>
              <BrandLogo variant="full" size="lg" decorative className="auth-hero-logo" />
              <h2 id="auth-brand-title" className="auth-brand-title display-heading">The good kind of buzz.</h2>
              <p className="auth-brand-tagline">Your people. Your conversations. One place that feels like you.</p>
            </div>
            <ul className="auth-feature-list">
              <li><MessageCircle size={18} aria-hidden="true" /><span>A little nostalgia. A lot to say.</span></li>
              <li><Users size={18} aria-hidden="true" /><span>Friends and conversations, together.</span></li>
              <li><ShieldCheck size={18} aria-hidden="true" /><span>Clear security status at every step.</span></li>
            </ul>
            <p className="auth-brand-footnote">Inspired by the messenger you remember.</p>
          </section>
          <div className="auth-card-panel">{children}</div>
        </div>
        <footer className="auth-footer"><span>Yahoo! Security Messenger 2.0</span><span>Stay close. Stay curious.</span></footer>
      </div>
    </main>
  );
}

/** Branded restoration state without an auth-provider dependency. */
export function AuthLoading({ message = 'Restoring your session…' }: { message?: string }) {
  return (
    <AuthShell>
      <section className="auth-card auth-loading" role="status" aria-live="polite" aria-atomic="true">
        <span className="auth-loading-indicator" aria-hidden="true" />
        <h1 className="auth-heading display-heading">One moment.</h1>
        <p className="auth-description">{message}</p>
      </section>
    </AuthShell>
  );
}
