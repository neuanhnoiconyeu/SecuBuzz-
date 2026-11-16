import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui';

/** A future media adapter supplies actual device state and SDK-backed callbacks. */
export interface DirectCallMediaControls {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  pending?: boolean;
  onToggleMicrophone(): void;
  onToggleCamera(): void;
}
export function DirectCallControls({ enabled, media, onHangUp }: { enabled: boolean; media?: DirectCallMediaControls; onHangUp(): void }) {
  const available = enabled && Boolean(media) && !media?.pending;
  return <div className="direct-call-controls" role="group" aria-label="Call controls">
    <Button variant="outline" disabled={!available} aria-label={media?.microphoneEnabled ? 'Mute call microphone' : 'Unmute call microphone'}
      aria-pressed={Boolean(media?.microphoneEnabled)} title={available ? 'Toggle microphone' : 'Microphone control is available after a real call connects'}
      leadingIcon={media?.microphoneEnabled ? <Mic size={20} aria-hidden="true" /> : <MicOff size={20} aria-hidden="true" />} onClick={() => media?.onToggleMicrophone()}>Microphone</Button>
    <Button variant="outline" disabled={!available} aria-label={media?.cameraEnabled ? 'Turn call camera off' : 'Turn call camera on'}
      aria-pressed={Boolean(media?.cameraEnabled)} title={available ? 'Toggle camera' : 'Camera control is available after a real call connects'}
      leadingIcon={media?.cameraEnabled ? <Video size={20} aria-hidden="true" /> : <VideoOff size={20} aria-hidden="true" />} onClick={() => media?.onToggleCamera()}>Camera</Button>
    <Button variant="danger" aria-label="Hang up call" leadingIcon={<PhoneOff size={20} aria-hidden="true" />} onClick={onHangUp}>Hang up</Button>
  </div>;
}
