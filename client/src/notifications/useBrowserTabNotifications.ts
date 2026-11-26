import { useEffect, useRef } from 'react';
import { BRAND_NAME } from '@/components/branding/brandConstants';
import type { DirectCallKind } from '@/calls/directCallMachine';

/** Presentation only: the authenticated workspace remains the sole unread/read owner. */
export function useBrowserTabNotifications(unread: Readonly<Record<string, number>>, incomingCall: DirectCallKind | null) {
  const total = Object.values(unread).reduce((sum, count) => Number.isFinite(count) && count > 0 ? Math.min(100, sum + Math.floor(count)) : sum, 0);
  const prefix = total ? `(${total > 99 ? '99+' : total}) ` : '';
  const title = `${prefix}${incomingCall ? `Incoming ${incomingCall} call · ` : ''}${BRAND_NAME}`;
  const writtenTitle = useRef<string>();
  useEffect(() => {
    const original = document.title;
    return () => { if (document.title === writtenTitle.current) document.title = original; };
  }, []);
  useEffect(() => { document.title = title; writtenTitle.current = title; }, [title]);

  const hasUnread = total > 0;
  useEffect(() => {
    if (!hasUnread) return;
    // Leave Apple touch icons and the original link elements/branding intact.
    const icons = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map(link => ({
      link, href: link.getAttribute('href'), type: link.getAttribute('type'), sizes: link.getAttribute('sizes'),
    }));
    if (!icons.length) return;
    const controller = new AbortController(); let active = true, badge: string | undefined;
    void fetch('/branding/favicon.svg', { credentials: 'omit', cache: 'force-cache', signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Favicon unavailable'); return response.text(); })
      .then(source => {
        if (!active) return;
        const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
        if (svg.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg' || svg.querySelector('parsererror')) return;
        const [x, y, width, height] = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        const dot = document.createElementNS(svg.namespaceURI, 'circle'), radius = Math.min(width, height) / 8;
        dot.setAttribute('cx', String(x + width - radius - 1)); dot.setAttribute('cy', String(y + radius + 1));
        dot.setAttribute('r', String(radius)); dot.setAttribute('fill', '#e5484d');
        dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '2'); dot.setAttribute('data-notification-dot', 'true');
        svg.append(dot);
        badge = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
        for (const { link } of icons) { link.setAttribute('href', badge); link.setAttribute('type', 'image/svg+xml'); link.setAttribute('sizes', 'any'); }
      }).catch(() => { /* Keep the original favicon if the static artwork cannot load. The title still works. */ });
    return () => {
      active = false; controller.abort();
      for (const { link, ...attributes } of icons) {
        if (!badge || link.getAttribute('href') !== badge) continue;
        for (const [name, value] of Object.entries(attributes)) {
          if (value === null) link.removeAttribute(name); else link.setAttribute(name, value);
        }
      }
    };
  }, [hasUnread]);
}
