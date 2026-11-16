import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_ROOMS } from './voiceRooms';

type Device = 'audio' | 'video';
type Devices<T> = Record<Device, T>;
const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop());

/** Local membership and real device previews only. This never opens a voice connection. */
export function useVoiceRooms(session: object) {
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [streams, setStreams] = useState<Devices<MediaStream | null>>({ audio: null, video: null });
  const [pending, setPending] = useState<Devices<boolean>>({ audio: false, video: false });
  const [errors, setErrors] = useState<Devices<string | null>>({ audio: null, video: null });
  const room = useRef<string | null>(null);
  const media = useRef<Devices<MediaStream | null>>({ audio: null, video: null });
  const requests = useRef<Devices<number>>({ audio: 0, video: 0 });
  const requesting = useRef<Devices<boolean>>({ audio: false, video: false });

  const release = useCallback(() => {
    room.current = null;
    for (const device of ['audio', 'video'] as const) {
      requests.current[device] += 1;
      requesting.current[device] = false;
      stopStream(media.current[device]);
      media.current[device] = null;
    }
  }, []);

  const leave = useCallback(() => {
    release();
    setJoinedRoomId(null);
    setStreams({ audio: null, video: null });
    setPending({ audio: false, video: false });
    setErrors({ audio: null, video: null });
  }, [release]);

  useEffect(() => {
    leave();
    return release;
  }, [session, leave, release]);

  const join = (roomId: string) => {
    if (!VOICE_ROOMS.some((entry) => entry.id === roomId) || room.current === roomId) return;
    leave();
    room.current = roomId;
    setJoinedRoomId(roomId);
  };

  const toggleDevice = async (device: Device) => {
    if (!room.current || requesting.current[device]) return;
    setErrors((previous) => ({ ...previous, [device]: null }));
    if (media.current[device]) {
      requests.current[device] += 1;
      stopStream(media.current[device]);
      media.current[device] = null;
      setStreams((previous) => ({ ...previous, [device]: null }));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrors((previous) => ({ ...previous, [device]: 'Device access is unavailable in this browser. Use HTTPS or localhost.' }));
      return;
    }

    const request = ++requests.current[device];
    requesting.current[device] = true;
    setPending((previous) => ({ ...previous, [device]: true }));
    const isCurrent = () => request === requests.current[device] && room.current !== null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: device === 'audio', video: device === 'video' });
      if (!isCurrent()) { stopStream(stream); return; }
      const tracks = device === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
      if (!tracks.some((track) => track.readyState === 'live')) {
        stopStream(stream);
        throw new Error('No live track');
      }
      media.current[device] = stream;
      const ended = () => {
        if (media.current[device] !== stream) return;
        stopStream(stream);
        media.current[device] = null;
        setStreams((previous) => ({ ...previous, [device]: null }));
        setErrors((previous) => ({ ...previous, [device]: `${device === 'audio' ? 'Microphone' : 'Camera'} access ended. You can try again.` }));
      };
      tracks.forEach((track) => track.addEventListener('ended', ended, { once: true }));
      setStreams((previous) => ({ ...previous, [device]: stream }));
    } catch (error) {
      if (!isCurrent()) return;
      const name = error instanceof Error ? error.name : '';
      const deviceName = device === 'audio' ? 'Microphone' : 'Camera';
      const message = name === 'NotAllowedError' ? `${deviceName} permission was denied. Allow access in your browser to try again.`
        : name === 'NotFoundError' ? `No ${device === 'audio' ? 'microphone' : 'camera'} was found.`
          : `${deviceName} could not be opened. Check your device and try again.`;
      setErrors((previous) => ({ ...previous, [device]: message }));
    } finally {
      if (isCurrent()) {
        requesting.current[device] = false;
        setPending((previous) => ({ ...previous, [device]: false }));
      }
    }
  };

  return { mode: 'local-preview' as const, joinedRoomId, join, leave, streams, pending, errors, toggleDevice };
}

export type VoiceRoomsController = ReturnType<typeof useVoiceRooms>;
