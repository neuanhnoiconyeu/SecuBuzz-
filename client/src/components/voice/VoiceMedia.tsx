import { useEffect, useRef } from 'react';
import type { LocalVideoTrack, RemoteVideoTrack, RemoteAudioTrack } from 'livekit-client';
import type { LiveVoiceRoomController } from '@/voice/useLiveVoiceRoom';

function RemoteAudio({ track, onBlocked }: { track: RemoteAudioTrack; onBlocked(): void }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    try { track.attach(element); void element.play()?.catch(() => { if (active) onBlocked(); }); }
    catch { onBlocked(); }
    return () => { active = false; track.detach(element); element.pause(); element.srcObject = null; };
  }, [track, onBlocked]);
  return <audio ref={ref} autoPlay />;
}

/** Keep this mounted at workspace scope so audio continues while browsing rooms. */
export function VoiceRoomAudio({ controller }: { controller: LiveVoiceRoomController }) {
  return <div className="voice-audio-output" aria-hidden="true">
    {controller.audio.map(({ id, track }) => <RemoteAudio key={id} track={track} onBlocked={controller.reportPlaybackBlocked} />)}
  </div>;
}

export type VideoPlaybackState = 'loading' | 'ready' | 'error';
type VoiceVideoProps = { local: boolean; label?: string; onPlaybackState?(state: VideoPlaybackState): void } &
  ({ track: LocalVideoTrack | RemoteVideoTrack; stream?: never } | { stream: MediaStream; track?: never });

/** Rendering only: capture, publishing and the voice connection remain owned by the room. */
export function VoiceVideo({ track, stream, local, label, onPlaybackState }: VoiceVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    const report = (state: VideoPlaybackState) => { if (active) onPlaybackState?.(state); };
    const ready = () => report('ready');
    const waiting = () => report('loading');
    const failed = () => report('error');
    element.addEventListener('loadeddata', ready); element.addEventListener('playing', ready);
    element.addEventListener('waiting', waiting); element.addEventListener('emptied', waiting);
    element.addEventListener('error', failed); element.addEventListener('ended', failed);
    report('loading');
    try {
      if (track) track.attach(element); else element.srcObject = stream;
      void element.play()?.catch(failed);
      if (element.readyState >= 2) ready();
    } catch { failed(); }
    return () => {
      active = false;
      element.removeEventListener('loadeddata', ready); element.removeEventListener('playing', ready);
      element.removeEventListener('waiting', waiting); element.removeEventListener('emptied', waiting);
      element.removeEventListener('error', failed); element.removeEventListener('ended', failed);
      try { track?.detach(element); } catch { /* Clear the element even if the SDK already removed the track. */ }
      element.pause(); element.srcObject = null;
    };
  }, [track, stream, onPlaybackState]);
  // Audio is rendered once by VoiceRoomAudio, including for remote camera tracks.
  return <video ref={ref} autoPlay playsInline muted className={`voice-camera-preview ${local ? 'is-local' : ''}`} aria-label={label ?? (local ? 'Your camera' : 'Participant camera')} />;
}
