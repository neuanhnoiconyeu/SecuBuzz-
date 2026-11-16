import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, Room, RemoteAudioTrack, LocalVideoTrack, RemoteVideoTrack } from 'livekit-client';
import type { AuthUser } from '@/auth/authModel';
import { LiveKitConnectionError, type LiveKitConnectionService, type LiveKitSnapshot } from './livekitConnection';
import { VOICE_ROOMS } from './voiceRooms';
const catalogRoom = (id: string) => VOICE_ROOMS.some(room => room.id === id);

export interface VoiceParticipant {
  id: string;
  name: string;
  isLocal: boolean;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  speaking: boolean;
  video: LocalVideoTrack | RemoteVideoTrack | null;
  screen?: LocalVideoTrack | RemoteVideoTrack | null;
}
interface RoomMedia {
  participants: VoiceParticipant[];
  audio: { id: string; track: RemoteAudioTrack }[];
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  needsPlayback: boolean;
}
const emptyMedia = (): RoomMedia => ({ participants: [], audio: [], microphoneEnabled: false, cameraEnabled: false, screenShareEnabled: false, needsPlayback: false });
type Device = 'audio' | 'video' | 'screen';
const stopLocalTracks = (room: Room) => room.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
function deviceError(error: unknown, device: Device): string {
  if (device === 'screen') return 'Screen sharing could not start or was cancelled. Choose a screen or window to try again. Voice stays connected.';
  const name = error instanceof Error ? error.name : '';
  if (device === 'video') {
    const reason = name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser and try again.'
      : name === 'NotFoundError' ? 'No camera was found.'
        : name === 'NotReadableError' ? 'The camera is busy or unavailable. Close other camera apps and try again.'
          : 'The camera could not be started. Check the device and try again.';
    return `${reason} Voice stays connected.`;
  }
  const label = device === 'audio' ? 'Microphone' : 'Camera';
  return name === 'NotAllowedError' ? `${label} permission was denied. Allow access in your browser and try again. You can still listen.`
    : name === 'NotFoundError' ? `No ${device === 'audio' ? 'microphone' : 'camera'} was found.`
      : `${label} could not be started. Check the device and try again.`;
}

/** One real media session. The connection service retains ownership of the SDK and token lifecycle. */
export function useLiveRoomMedia(service: LiveKitConnectionService | null, user: AuthUser, allowed: (id: string) => boolean) {
  const [connection, setConnection] = useState<LiveKitSnapshot>({ status: 'disabled', roomId: null, error: 'disabled' });
  const [media, setMedia] = useState<RoomMedia>(emptyMedia);
  const [pending, setPending] = useState({ audio: false, video: false, screen: false });
  const [errors, setErrors] = useState<{ audio: string | null; video: string | null; screen: string | null }>({ audio: null, video: null, screen: null });
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const generation = useRef(0);
  const deviceBusy = useRef({ audio: false, video: false, screen: false });
  const refresh = useRef<() => void>(() => {});
  const currentUser = useRef(user); currentUser.current = user;
  const activeService = useRef(service);
  const playbackBlocked = useRef(false);

  useEffect(() => {
    activeService.current = service;
    let active = true;
    let bound: Room | null = null;
    let speakers = new Set<string>();
    let unbind = () => {};
    const update = () => {
      if (!active) return;
      const state = service?.getSnapshot();
      if (!bound || (state?.status !== 'connected' && state?.status !== 'reconnecting')) { setMedia(emptyMedia()); return; }
      const room = bound;
      const identities = new Set([room.localParticipant.identity, ...room.remoteParticipants.keys()]);
      speakers = new Set([...speakers].filter((identity) => identities.has(identity)));
      const participant = (person: Participant, isLocal: boolean): VoiceParticipant => {
        const video = [...person.videoTrackPublications.values()].find((publication) => publication.source === 'camera' && !publication.isMuted)?.track;
        const screen = [...person.videoTrackPublications.values()].find(publication => publication.source === 'screen_share' && !publication.isMuted)?.track;
        if (!person.isMicrophoneEnabled) speakers.delete(person.identity);
        return { id: person.identity, name: isLocal ? currentUser.current.displayName : person.name?.trim().slice(0, 160) || `Participant ${person.identity.slice(0, 8)}`,
          isLocal, microphoneEnabled: person.isMicrophoneEnabled, cameraEnabled: person.isCameraEnabled,
          speaking: state.status === 'connected' && person.isMicrophoneEnabled && speakers.has(person.identity),
          screen: screen?.kind === 'video' ? screen as LocalVideoTrack | RemoteVideoTrack : null,
          video: video?.kind === 'video' ? video as LocalVideoTrack | RemoteVideoTrack : null };
      };
      const allowedIds = service?.getParticipantIds();
      const remotes = [...room.remoteParticipants.values()].filter(person => !allowedIds || allowedIds.has(person.identity));
      setMedia({ participants: [participant(room.localParticipant, true), ...remotes.map((person) => participant(person, false))],
        audio: remotes.flatMap((person) => [...person.audioTrackPublications.values()].flatMap((publication) =>
          publication.track?.kind === 'audio' ? [{ id: `${person.identity}:${publication.trackSid}`, track: publication.track as RemoteAudioTrack }] : [])),
        microphoneEnabled: room.localParticipant.isMicrophoneEnabled, cameraEnabled: room.localParticipant.isCameraEnabled,
        screenShareEnabled: Boolean(room.localParticipant.isScreenShareEnabled),
        needsPlayback: playbackBlocked.current || !room.canPlaybackAudio });
    };
    refresh.current = update;
    const observe = (snapshot: LiveKitSnapshot) => {
      if (!active) return;
      setConnection(snapshot);
      const next = service?.getRoom()?.media ?? null;
      if (next !== bound) {
        unbind(); bound = next; speakers = new Set(); playbackBlocked.current = false;
        if (bound) {
          const room = bound;
          const events = ['participantConnected', 'participantDisconnected', 'participantNameChanged', 'participantPermissionsChanged', 'trackPublished',
            'trackUnpublished', 'trackSubscribed', 'trackUnsubscribed', 'trackMuted', 'trackUnmuted', 'localTrackPublished', 'localTrackUnpublished'] as const;
          for (const event of events) room.on(event, update);
          const devices = (failure: Error, kind?: MediaDeviceKind) => {
            if (!active || bound !== room || (kind && kind !== 'audioinput' && kind !== 'videoinput')) return;
            const device = kind === 'videoinput' ? 'video' : 'audio';
            setErrors((previous) => ({ ...previous, [device]: deviceError(failure, device) }));
          };
          room.on('mediaDevicesError', devices);
          const speaking = (people: Participant[]) => { speakers = new Set(service?.getSnapshot().status === 'connected' ? people.map((person) => person.identity) : []); update(); };
          const playback = (playing: boolean) => { playbackBlocked.current = !playing; update(); };
          room.on('activeSpeakersChanged', speaking); room.on('audioPlaybackChanged', playback);
          unbind = () => { for (const event of events) room.off(event, update); room.off('mediaDevicesError', devices);
            room.off('activeSpeakersChanged', speaking); room.off('audioPlaybackChanged', playback); };
        }
      }
      if (snapshot.status === 'disconnected' || snapshot.status === 'error' || snapshot.status === 'disabled') {
        generation.current += 1; deviceBusy.current = { audio: false, video: false, screen: false };
        setPending({ audio: false, video: false, screen: false });
        if (bound) { stopLocalTracks(bound); unbind(); bound = null; }
      }
      if (snapshot.status !== 'connected') speakers.clear();
      update();
    };
    setMedia(emptyMedia()); setErrors({ audio: null, video: null, screen: null }); setError(null); setLeaving(false);
    if (service) observe(service.getSnapshot());
    else setConnection({ status: 'disabled', roomId: null, error: 'disabled' });
    const unsubscribe = service?.subscribe(observe);
    return () => {
      active = false; generation.current += 1; deviceBusy.current = { audio: false, video: false, screen: false };
      if (activeService.current === service) activeService.current = null;
      unsubscribe?.(); unbind(); refresh.current = () => {};
      if (bound) stopLocalTracks(bound);
      void service?.disconnect();
    };
  }, [service]);

  const setDevice = async (device: Device, enabled: boolean, operation: number) => {
    const room = service?.getRoom()?.media;
    if (!room || deviceBusy.current[device] || operation !== generation.current) return;
    deviceBusy.current[device] = true;
    setPending((previous) => ({ ...previous, [device]: true }));
    setErrors((previous) => ({ ...previous, [device]: null }));
    try {
      const publication = device === 'audio'
        ? await room.localParticipant.setMicrophoneEnabled(enabled, { echoCancellation: true, noiseSuppression: true, autoGainControl: true })
        : device === 'screen' ? await room.localParticipant.setScreenShareEnabled(enabled, { audio: false }) : await room.localParticipant.setCameraEnabled(enabled);
      if (operation !== generation.current || service?.getRoom()?.media !== room) { publication?.track?.stop(); stopLocalTracks(room); return; }
      if (enabled && !(device === 'audio' ? room.localParticipant.isMicrophoneEnabled : device === 'screen' ? room.localParticipant.isScreenShareEnabled : room.localParticipant.isCameraEnabled)) {
        throw new Error('Device did not start.');
      }
      refresh.current();
    } catch (failure) {
      if (operation === generation.current) { setErrors((previous) => ({ ...previous, [device]: deviceError(failure, device) })); refresh.current(); }
    } finally {
      if (operation === generation.current) { deviceBusy.current[device] = false; setPending((previous) => ({ ...previous, [device]: false })); }
    }
  };

  const join = async (roomId: string, options?: { camera: boolean }) => {
    if (!service || !allowed(roomId)) return;
    const state = service.getSnapshot();
    if (state.roomId === roomId && ['requesting-token', 'connecting', 'connected', 'reconnecting'].includes(state.status)) return;
    const operation = ++generation.current; setError(null); setErrors({ audio: null, video: null, screen: null }); setPending({ audio: false, video: false, screen: false });
    deviceBusy.current = { audio: false, video: false, screen: false };
    try {
      await service.connect(roomId);
      if (operation !== generation.current || activeService.current !== service || service.getSnapshot().roomId !== roomId) return;
      const room = service.getRoom()?.media;
      if (!room) { setError('The voice session does not support media. Please reconnect.'); await service.disconnect(); return; }
      void room.startAudio().catch(() => { if (generation.current === operation) { playbackBlocked.current = true; refresh.current(); } });
      await setDevice('audio', true, operation);
      if (options?.camera && operation === generation.current) await setDevice('video', true, operation);
    } catch (failure) {
      if (operation !== generation.current || activeService.current !== service || (failure instanceof LiveKitConnectionError && failure.code === 'cancelled')) return;
      setError(failure instanceof LiveKitConnectionError ? failure.message : 'The voice connection failed. Please try again.');
    }
  };
  const leave = useCallback(async () => {
    ++generation.current; deviceBusy.current = { audio: false, video: false, screen: false };
    setPending({ audio: false, video: false, screen: false }); setErrors({ audio: null, video: null, screen: null }); setError(null); setLeaving(true);
    const room = service?.getRoom()?.media;
    if (room) stopLocalTracks(room);
    setMedia(emptyMedia());
    await service?.disconnect();
    if (activeService.current === service) setLeaving(false);
  }, [service]);
  const toggleDevice = async (device: Device) => {
    const room = service?.getRoom()?.media;
    if (!room) return;
    const enabled = device === 'audio' ? room.localParticipant.isMicrophoneEnabled : device === 'screen' ? room.localParticipant.isScreenShareEnabled : room.localParticipant.isCameraEnabled;
    if (!enabled && service?.getSnapshot().status !== 'connected') return;
    await setDevice(device, !enabled, generation.current);
  };
  const enablePlayback = async () => {
    const room = service?.getRoom()?.media; const operation = generation.current;
    try { await room?.startAudio(); if (operation === generation.current) { playbackBlocked.current = !room?.canPlaybackAudio; setError(null); refresh.current(); } }
    catch { if (operation === generation.current) { playbackBlocked.current = true; setError('Audio playback is blocked. Use Enable sound to try again.'); refresh.current(); } }
  };

  const status = leaving ? 'leaving' as const : connection.status;
  const reportPlaybackBlocked = useCallback(() => { playbackBlocked.current = true; setMedia((previous) => ({ ...previous, needsPlayback: true })); }, []);
  return { mode: 'live' as const, status, targetRoomId: connection.roomId,
    joinedRoomId: !leaving && ['connected', 'reconnecting'].includes(connection.status) ? connection.roomId : null,
    ...media, pending, errors, join, leave, toggleDevice, enablePlayback, reportPlaybackBlocked,
    connectionError: error ?? (connection.error ? new LiveKitConnectionError(connection.error).message : null),
    canJoin: Boolean(service) && connection.status !== 'disabled' && !leaving };
}
export function useLiveVoiceRoom(service: LiveKitConnectionService | null, user: AuthUser) {
  return useLiveRoomMedia(service, user, catalogRoom);
}
export type LiveVoiceRoomController = ReturnType<typeof useLiveVoiceRoom>;
