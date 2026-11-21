import { useEffect, useId } from 'react';
import type { RefObject } from 'react';

const openedEvent = 'secubuzz:message-popover-open';
/** Uses the browser top layer without moving controls out of their disabled fieldset. */
export function useAnchoredMessagePopover(panelRef: RefObject<HTMLDivElement>, triggerRef: RefObject<HTMLButtonElement | null>,
  openKey: string | null, onClose: (restoreFocus?: boolean) => void, expanded = false, boundaryRef?: RefObject<HTMLElement>) {
  const id = useId();
  useEffect(() => {
    if (!openKey) return;
    const panel = panelRef.current, trigger = triggerRef.current;
    if (!panel || !trigger) return;
    let topLayer = false;
    if (typeof panel.showPopover === 'function') {
      try { panel.setAttribute('popover', 'manual'); panel.showPopover(); topLayer = true; }
      catch { panel.removeAttribute('popover'); }
    }
    const position = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const viewportBounds = { left, top, right: left + (viewport?.width ?? window.innerWidth), bottom: top + (viewport?.height ?? window.innerHeight) };
      const boundary = !topLayer ? boundaryRef?.current?.getBoundingClientRect() : undefined;
      const bounds = boundary && boundary.width && boundary.height ? {
        left: Math.max(viewportBounds.left, boundary.left), top: Math.max(viewportBounds.top, boundary.top),
        right: Math.min(viewportBounds.right, boundary.right), bottom: Math.min(viewportBounds.bottom, boundary.bottom),
      } : viewportBounds;
      panel.style.maxWidth = `${Math.max(1, bounds.right - bounds.left - 16)}px`;
      panel.style.maxHeight = `${Math.max(1, bounds.bottom - bounds.top - 16)}px`;
      if (topLayer) { panel.style.position = 'fixed'; panel.style.margin = '0'; }
      const anchor = trigger.getBoundingClientRect();
      const rect = panel.getBoundingClientRect();
      // Pop-in transforms temporarily shrink the bounding rect. Measure the final layout
      // size so the animation cannot leave a popup outside a narrow viewport.
      const width = panel.offsetWidth || rect.width, height = panel.offsetHeight || rect.height;
      const origin = topLayer ? { left: 0, top: 0 } : panel.offsetParent?.getBoundingClientRect();
      if (!origin || !width || !height) return;
      const x = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8));
      const preferred = anchor.top - height - 8 >= bounds.top + 8 ? anchor.top - height - 8 : anchor.bottom + 8;
      const y = Math.max(bounds.top + 8, Math.min(preferred, bounds.bottom - height - 8));
      Object.assign(panel.style, { left: `${x - origin.left}px`, top: `${y - origin.top}px`, right: 'auto', bottom: 'auto' });
    };
    position();
    document.dispatchEvent(new CustomEvent(openedEvent, { detail: id }));
    const otherOpened = (event: Event) => { if ((event as CustomEvent).detail !== id) onClose(); };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !trigger.contains(event.target)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(true); } };
    const resize = () => { if (expanded) position(); else onClose(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !panel.contains(event.target)) position(); };
    document.addEventListener(openedEvent, otherOpened);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', keyboard);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      document.removeEventListener(openedEvent, otherOpened);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      if (topLayer) { try { panel.hidePopover(); } catch { /* Already detached or hidden. */ } panel.removeAttribute('popover'); }
    };
  }, [openKey, onClose, id, expanded, panelRef, triggerRef, boundaryRef]);
}
