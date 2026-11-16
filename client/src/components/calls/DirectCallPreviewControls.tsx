import type { DirectCallKind } from '@/calls/directCallMachine';
import { Button } from '@/components/ui';

export function DirectCallPreviewControls({ disabled, onIncoming }: { disabled: boolean; onIncoming(kind: DirectCallKind): void }) {
  if (process.env.NODE_ENV === 'production') return null;
  return <details className="direct-call-preview-controls"><summary>Direct call UI preview</summary>
    <p>No calls are sent. These controls preview an incoming notification from the selected conversation.</p>
    <div><Button size="sm" variant="outline" disabled={disabled} onClick={() => onIncoming('voice')}>Preview incoming voice call</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => onIncoming('video')}>Preview incoming video call</Button></div>
  </details>;
}
