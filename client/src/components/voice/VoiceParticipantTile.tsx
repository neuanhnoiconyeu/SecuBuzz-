import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, Mic, MicOff, VideoOff } from 'lucide-react';
import type { AuthUser } from '@/auth/authModel';
import { Avatar } from '@/components/ui';
import { ProfileAvatar } from '@/components/profile/ProfileAvatar';
import type { VoiceParticipant } from '@/voice/useLiveVoiceRoom';
import { VoiceVideo, type VideoPlaybackState } from './VoiceMedia';

type NativeFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsFullscreen?: boolean;
};
export function VoiceParticipantAvatar({ person, user, size = 'lg' }: { person: VoiceParticipant; user: AuthUser; size?: 'sm' | 'lg' }) {
  return person.isLocal ? <ProfileAvatar displayName={user.displayName} avatar={user.avatar} size={size} /> : <Avatar name={person.name} size={size} />;
}

export function VoiceParticipantTile({ person, user, preview = false, previewStream = null }: {
  person: VoiceParticipant; user: AuthUser; preview?: boolean; previewStream?: MediaStream | null;
}) {
  const card = useRef<HTMLDivElement>(null);
  const source = person.video ?? previewStream;
  const hasVideo = Boolean(source);
  const [playback, setPlayback] = useState<{ source: typeof source; state: VideoPlaybackState }>({ source: null, state: 'loading' });
  const videoState = playback.source === source ? playback.state : 'loading';
  const onPlaybackState = useCallback((state: VideoPlaybackState) => setPlayback({ source, state }), [source]);
  const [fullscreen, setFullscreen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const requests = useRef({ version: 0, busy: false }).current;

  useEffect(() => {
    const element = card.current;
    const video = element?.querySelector<NativeFullscreenVideo>('video');
    requests.busy = false; setFullscreenError(null);
    const sync = () => {
      setFullscreen(Boolean(element && (document.fullscreenElement === element || video?.webkitDisplayingFullscreen)));
      setSupported(Boolean(element?.requestFullscreen && document.fullscreenEnabled !== false) ||
        Boolean(video?.webkitEnterFullscreen && video.webkitSupportsFullscreen !== false));
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    video?.addEventListener('webkitbeginfullscreen', sync); video?.addEventListener('webkitendfullscreen', sync);
    video?.addEventListener('loadedmetadata', sync);
    return () => {
      ++requests.version; requests.busy = false;
      document.removeEventListener('fullscreenchange', sync);
      video?.removeEventListener('webkitbeginfullscreen', sync); video?.removeEventListener('webkitendfullscreen', sync);
      video?.removeEventListener('loadedmetadata', sync);
      if (element && document.fullscreenElement === element) void document.exitFullscreen?.().catch(() => {});
      if (video?.webkitDisplayingFullscreen) { try { video.webkitExitFullscreen?.(); } catch { /* Native controls may already have closed. */ } }
    };
  }, [hasVideo, requests]);

  const toggleFullscreen = async () => {
    const element = card.current;
    const video = element?.querySelector<NativeFullscreenVideo>('video');
    if (!element || requests.busy) return;
    const request = ++requests.version;
    requests.busy = true; setFullscreenError(null);
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else if (video?.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      else if (element.requestFullscreen && document.fullscreenEnabled !== false) await element.requestFullscreen();
      else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else throw new Error('Fullscreen unavailable.');
      if (request !== requests.version || !element.isConnected) {
        if (document.fullscreenElement === element) await document.exitFullscreen();
        return;
      }
      setFullscreen(document.fullscreenElement === element || Boolean(video?.webkitDisplayingFullscreen));
    } catch {
      if (request === requests.version) setFullscreenError('Fullscreen could not be opened. Voice stays connected.');
    } finally { if (request === requests.version) requests.busy = false; }
  };

  const cameraState = !person.cameraEnabled && !hasVideo ? 'off' : videoState === 'error' ? 'error' : hasVideo && videoState === 'ready' ? 'live' : 'loading';
  return <div ref={card} className={`voice-self-card voice-participant-tile ${person.speaking ? 'is-speaking' : ''}`}
    data-participant-id={person.id} data-camera={cameraState} aria-label={person.speaking ? `${person.name}, speaking` : person.name}>
    {person.video ? <VoiceVideo track={person.video} local={person.isLocal} label={person.isLocal ? 'Your camera' : `${person.name}'s camera`} onPlaybackState={onPlaybackState} />
      : previewStream ? <VoiceVideo stream={previewStream} local label="Your local camera preview" onPlaybackState={onPlaybackState} /> : null}
    {cameraState !== 'live' && <div className="voice-tile-placeholder">
      <VoiceParticipantAvatar person={person} user={user} />
      <span>{cameraState === 'off' ? <><VideoOff size={13} aria-hidden="true" />Camera off</> : cameraState === 'error' ? 'Video unavailable · Voice continues' : 'Waiting for video…'}</span>
    </div>}
    {(hasVideo || fullscreen) && <button type="button" className="voice-fullscreen-button" onClick={() => void toggleFullscreen()}
      disabled={!supported && !fullscreen} aria-label={`${fullscreen ? 'Exit fullscreen for' : 'Fullscreen video for'} ${person.name}`}
      title={supported ? fullscreen ? 'Exit fullscreen' : 'Fullscreen video' : 'Fullscreen unavailable in this browser'}>
      {fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
    </button>}
    {fullscreenError && <p className="voice-fullscreen-error" role="alert">{fullscreenError}</p>}
    <div className="voice-self-caption"><span>{person.name}<small>{person.speaking ? 'Speaking' : person.isLocal ? preview ? 'You · Local preview' : 'You' : 'Participant'}</small></span>
      {person.microphoneEnabled ? <Mic size={17} aria-label={preview ? 'Local microphone on' : 'Microphone on'} /> : <MicOff size={17} aria-label="Microphone muted" />}
    </div>
  </div>;
}
