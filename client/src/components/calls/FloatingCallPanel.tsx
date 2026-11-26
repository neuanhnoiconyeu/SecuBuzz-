import { useCallback, useEffect, useRef, useState } from 'react';
import { Expand, Maximize, Maximize2, Minimize, Minimize2, MonitorOff, MonitorUp, Shrink } from 'lucide-react';
import type { LiveDirectCallsController } from '@/calls/useLiveDirectCalls';
import { isCallFinished } from '@/calls/directCallMachine';
import { Avatar, Button } from '@/components/ui';
import { DirectCallStatus } from './DirectCallStatus';
import { DirectCallControls } from './DirectCallControls';

export type CallDisplayMode = 'mini' | 'expanded' | 'fullscreen';

/** Presentation only: display-mode changes never alter connection, publication, or call state. */
export function FloatingCallPanel({ calls, children }: { calls: LiveDirectCallsController; children: React.ReactNode }) {
  const panelRef = useRef<HTMLElement>(null);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const requests = useRef({ version: 0, busy: false }).current;

  const isIdle = calls.state.phase === 'idle';
  const finished = !isIdle && isCallFinished(calls.state);

  const exitBrowserFullscreen = useCallback(async () => {
    const element = panelRef.current;
    if (element && document.fullscreenElement === element) {
      await document.exitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    if (isIdle) return;
    const element = panelRef.current;
    requests.busy = false;
    setFullscreenError(null);
    const sync = () => {
      const activeElement = panelRef.current;
      setFullscreen(Boolean(activeElement && document.fullscreenElement === activeElement));
      setFullscreenSupported(Boolean(activeElement?.requestFullscreen && document.fullscreenEnabled !== false));
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => {
      ++requests.version;
      requests.busy = false;
      document.removeEventListener('fullscreenchange', sync);
      if (element && document.fullscreenElement === element) {
        void document.exitFullscreen?.().catch(() => {});
      }
    };
  }, [isIdle, requests]);

  useEffect(() => {
    if (!finished) return;
    ++requests.version;
    requests.busy = false;
    setExpanded(false);
    setFullscreen(false);
    setFullscreenError(null);
    void exitBrowserFullscreen().catch(() => {});
  }, [finished, exitBrowserFullscreen, requests]);

  useEffect(() => {
    if (!expanded || fullscreen || finished || isIdle) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) {
        event.preventDefault();
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded, fullscreen, finished, isIdle]);

  if (calls.state.phase === 'idle') return null;
  const { state, media } = calls;
  const enabled = calls.ownedId === state.call.id && (state.phase === 'connected' || state.phase === 'reconnecting');
  const displayMode: CallDisplayMode = fullscreen ? 'fullscreen' : expanded ? 'expanded' : 'mini';

  const handleMinimize = () => {
    setFullscreenError(null);
    setExpanded(false);
    setMinimized(true);
    if (fullscreen || document.fullscreenElement === panelRef.current) {
      ++requests.version;
      requests.busy = false;
      setFullscreen(false);
      void exitBrowserFullscreen().catch(() => {});
    }
  };

  const handleExpand = () => {
    setFullscreenError(null);
    setMinimized(false);
    setExpanded(true);
  };

  const handleRestore = () => {
    setFullscreenError(null);
    setMinimized(false);
    setExpanded(false);
    if (fullscreen || document.fullscreenElement === panelRef.current) {
      ++requests.version;
      requests.busy = false;
      setFullscreen(false);
      void exitBrowserFullscreen().catch(() => {});
    }
  };

  const handleToggleFullscreen = async () => {
    const element = panelRef.current;
    if (!element || requests.busy) return;
    const request = ++requests.version;
    requests.busy = true;
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === element) {
        await document.exitFullscreen?.();
      } else if (element.requestFullscreen && document.fullscreenEnabled !== false) {
        setMinimized(false);
        await element.requestFullscreen();
      } else {
        throw new Error('Fullscreen unavailable.');
      }
      if (request !== requests.version || !element.isConnected) {
        if (document.fullscreenElement === element) await document.exitFullscreen?.();
        return;
      }
      setFullscreen(document.fullscreenElement === element);
    } catch {
      if (request === requests.version) {
        setFullscreen(false);
        setFullscreenError('Fullscreen could not be opened. Your call stays connected.');
      }
    } finally {
      if (request === requests.version) requests.busy = false;
    }
  };

  const modeClass = minimized ? 'is-minimized' : displayMode === 'fullscreen' ? 'is-fullscreen' : displayMode === 'expanded' ? 'is-expanded' : '';

  return <aside ref={panelRef} className={`floating-call-panel ${modeClass}`.trim()} data-display-mode={minimized ? 'minimized' : displayMode} aria-label={`Call with ${state.call.peer.name}`}>
    <header className="floating-call-header">
      <Avatar name={state.call.peer.name} {...(state.call.peer.avatarUrl ? { src: state.call.peer.avatarUrl } : {})} />
      <div><h2>{state.call.peer.name}</h2><DirectCallStatus state={state} /></div>
      <div className="floating-call-window-actions" role="group" aria-label="Call window display controls">
        {!finished && minimized && <>
          <button type="button" className="floating-call-toggle" aria-label="Restore call" title="Restore call window" onClick={handleRestore}>
            <Maximize2 size={18} aria-hidden="true" />
          </button>
          <button type="button" className="floating-call-toggle" aria-label="Expand call" title="Expand call window" onClick={handleExpand}>
            <Expand size={18} aria-hidden="true" />
          </button>
        </>}
        {!finished && !minimized && <>
          {displayMode === 'mini' ? (
            <button type="button" className="floating-call-toggle" aria-expanded={false} aria-label="Expand call" title="Expand call window" onClick={handleExpand}>
              <Expand size={18} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="floating-call-toggle" aria-expanded={true} aria-label="Restore call" title="Restore mini call window" onClick={handleRestore}>
              <Shrink size={18} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="floating-call-toggle"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-pressed={fullscreen}
            disabled={!fullscreenSupported && !fullscreen}
            title={fullscreen ? 'Exit fullscreen' : fullscreenSupported ? 'Enter fullscreen' : 'Fullscreen unavailable in this browser'}
            onClick={() => void handleToggleFullscreen()}>
            {fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
          </button>
          <button type="button" className="floating-call-toggle" aria-expanded={true} aria-label="Minimize call" title="Minimize call window" onClick={handleMinimize}>
            <Minimize2 size={18} aria-hidden="true" />
          </button>
        </>}
      </div>
    </header>
    {!finished && <p className="floating-call-participants" aria-label="Active call participants">{media.participants.length ? media.participants.map(person => `${person.name}${person.isLocal ? ' (you)' : ''}`).join(' · ') : 'Waiting for media connection'}</p>}
    {!minimized && !finished && <div className="floating-call-body">{children}</div>}
    {fullscreenError && <p role="alert" className="voice-device-error">{fullscreenError}</p>}
    {media.screenShareEnabled && <p role="status" className="direct-call-note">You are sharing your screen.</p>}
    {calls.error && <p role="alert" className="voice-device-error">{calls.error}</p>}
    {!finished ? <div className="floating-call-footer">
      <DirectCallControls enabled={enabled} media={{ microphoneEnabled: media.microphoneEnabled, cameraEnabled: media.cameraEnabled,
        pending: media.pending.audio || media.pending.video, onToggleMicrophone: () => void media.toggleDevice('audio'), onToggleCamera: () => void media.toggleDevice('video') }} onHangUp={() => calls.hangUp(state.call.id)} />
      <Button className="call-screen-share" variant="outline" disabled={!media.screenShareEnabled && (!enabled || media.status !== 'connected') || media.pending.screen}
        aria-label={media.screenShareEnabled ? 'Stop sharing screen' : 'Share screen'} aria-pressed={media.screenShareEnabled}
        leadingIcon={media.screenShareEnabled ? <MonitorOff size={18} aria-hidden="true" /> : <MonitorUp size={18} aria-hidden="true" />}
        onClick={() => void media.toggleDevice('screen')}>{media.screenShareEnabled ? 'Stop sharing' : 'Share screen'}</Button>
      {Object.entries(media.errors).map(([device, message]) => message && <p key={device} role="alert" className="voice-device-error">{message}</p>)}
      {media.needsPlayback && minimized && <Button onClick={() => void media.enablePlayback()}>Enable call sound</Button>}
    </div> : <Button variant="outline" onClick={() => calls.dismiss(state.call.id)}>Close call</Button>}
  </aside>;
}
