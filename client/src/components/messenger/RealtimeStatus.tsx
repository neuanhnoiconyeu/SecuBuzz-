import type { RealtimeConnectionStatus } from '@/realtime/realtimeModel';

export function RealtimeStatus({ status, demo = false }: { status: RealtimeConnectionStatus; demo?: boolean }) {
  const label = status === 'connected' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline';
  return <span className={`realtime-status realtime-status--${status}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="realtime-status-dot" aria-hidden="true" />{label}{demo ? ' · demo' : ''}
  </span>;
}
