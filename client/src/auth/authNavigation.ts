'use client';

import { useEffect, useState } from 'react';

const destinations = new Set(['/', '/#chats', '/#friends', '/#security']);

/** Only existing Messenger destinations are accepted, never arbitrary URLs or auth routes. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && destinations.has(value) ? value : '/';
}

export function useSafeReturnTo(): string {
  const [destination, setDestination] = useState('/');
  useEffect(() => {
    const update = () => setDestination(safeReturnTo(new URLSearchParams(window.location.search).get('next')));
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return destination;
}
