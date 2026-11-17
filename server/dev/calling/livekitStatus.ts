import type { LiveKitConfig } from '../../src/livekit/config.ts';
import './config.ts';

export type DevelopmentLiveKitProbe = { listRooms(): Promise<unknown> };
export type DevelopmentLiveKitStatus = 'available' | 'unavailable' | 'disabled' | 'unconfigured';

/** Read-only authenticated service probe. No room names, credentials or SDK diagnostics leave this boundary. */
export function createDevelopmentLiveKitStatus(config: LiveKitConfig, enabled: boolean, probe?: DevelopmentLiveKitProbe) {
  const service = config.directCallsReady ? probe ?? config.createRoomService() : null;
  let cached: { status: DevelopmentLiveKitStatus; at: number } | null = null;
  let pending: Promise<DevelopmentLiveKitStatus> | null = null;
  return (): Promise<DevelopmentLiveKitStatus> => {
    if (!service) return Promise.resolve(enabled ? 'unconfigured' : 'disabled');
    if (cached && Date.now() - cached.at < 5000) return Promise.resolve(cached.status);
    return pending ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let status: DevelopmentLiveKitStatus;
      try {
        await Promise.race([service.listRooms(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Service probe timed out.')), 3500); timer.unref();
        })]);
        status = 'available';
      } catch { status = 'unavailable'; }
      finally { if (timer) clearTimeout(timer); }
      cached = { status, at: Date.now() };
      return status;
    })().finally(() => { pending = null; });
  };
}
