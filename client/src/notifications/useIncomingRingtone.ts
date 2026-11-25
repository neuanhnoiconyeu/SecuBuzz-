import { useEffect } from 'react';
import { useNotificationAudio } from './NotificationSoundProvider';

export function useIncomingRingtone(id: string | null, expiresAt: number | null, ringing: boolean) {
  const audio = useNotificationAudio();
  useEffect(() => {
    if (!audio || !id || !ringing || expiresAt === null) return;
    audio.ring(id, expiresAt);
    return () => audio.stopRinging(id);
  }, [audio, id, expiresAt, ringing]);
  return audio;
}
