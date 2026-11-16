import type { DirectCallState } from '@/calls/directCallMachine';
import type { DirectCallMediaControls } from './DirectCallControls';
import { DirectCallWindow } from './DirectCallWindow';
import { IncomingCallNotification } from './IncomingCallNotification';
import type { ReactNode } from 'react';

export interface DirectCallActions { accept(id: string): void; decline(id: string): void; hangUp(id: string): void; dismiss(id: string): void }
export function DirectCallLayer({ state, actions, media, mediaContent, busy, canAccept, error }: {
  state: DirectCallState; actions: DirectCallActions; media?: DirectCallMediaControls; mediaContent?: ReactNode; busy?: boolean; canAccept?: boolean; error?: string | null;
}) {
  if (state.phase === 'idle') return null;
  const id = state.call.id;
  if (state.phase === 'ringing' && state.call.direction === 'incoming') return <IncomingCallNotification state={state}
    onAccept={() => actions.accept(id)} onDecline={() => actions.decline(id)} {...(busy !== undefined ? { busy } : {})} {...(canAccept !== undefined ? { canAccept } : {})} {...(error ? { error } : {})} />;
  return <DirectCallWindow state={state} onHangUp={() => actions.hangUp(id)} onDismiss={() => actions.dismiss(id)} {...(media ? { media } : {})}
    {...(mediaContent ? { mediaContent } : {})} {...(error ? { error } : {})} />;
}
