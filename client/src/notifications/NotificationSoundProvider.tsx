import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui';
import { NotificationAudio } from './notificationAudio';

export const notificationSoundKey = (accountId: string) => `secubuzz.notification-sounds.v1:${accountId}`;
const SoundContext = createContext<{ audio: NotificationAudio; setEnabled(value: boolean): void } | null>(null);
export const useNotificationAudio = () => useContext(SoundContext)?.audio ?? null;

export function NotificationSoundProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const [owned, setOwned] = useState<{ accountId: string; audio: NotificationAudio } | null>(null);
  const audio = owned?.accountId === accountId ? owned.audio : null;
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const key = notificationSoundKey(accountId);
  const setEnabled = useCallback((enabled: boolean) => {
    if (!audio) return;
    audio.setEnabled(enabled);
    try { localStorage.setItem(key, enabled ? 'on' : 'muted'); setStorageUnavailable(false); }
    catch { setStorageUnavailable(true); }
    if (enabled) void audio.unlock();
  }, [audio, key]);
  useEffect(() => {
    // Construct inside the effect so StrictMode's setup/cleanup replay owns fresh resources.
    const engine = new NotificationAudio(); setOwned({ accountId, audio: engine }); setStorageUnavailable(false);
    try { engine.setEnabled(localStorage.getItem(key) !== 'muted'); } catch { setStorageUnavailable(true); }
    const gesture = (event: Event) => {
      if (!event.isTrusted || !engine.getSnapshot().enabled || engine.getSnapshot().status === 'unavailable') return;
      if (event.type === 'keydown' && event.target instanceof Element && event.target.closest('[data-notification-audio-control], .incoming-call-actions')) return;
      void engine.unlock();
    };
    const storage = (event: StorageEvent) => { if (event.key === key) engine.setEnabled(event.newValue !== 'muted'); };
    document.addEventListener('click', gesture); document.addEventListener('keydown', gesture);
    window.addEventListener('storage', storage);
    return () => { document.removeEventListener('click', gesture); document.removeEventListener('keydown', gesture); window.removeEventListener('storage', storage); engine.dispose(); };
  }, [accountId, key]);
  const value = useMemo(() => audio ? { audio, setEnabled } : null, [audio, setEnabled]);
  return <SoundContext.Provider value={value}>{children}
    {storageUnavailable && <span role="status" className="sr-only">Notification sound preference could not be saved in this browser.</span>}
  </SoundContext.Provider>;
}

export function NotificationSoundToggle({ inlineHelp = false }: { inlineHelp?: boolean } = {}) {
  const controls = useContext(SoundContext);
  return controls ? <SoundToggle audio={controls.audio} setEnabled={controls.setEnabled} inlineHelp={inlineHelp} /> : null;
}
function SoundToggle({ audio, setEnabled, inlineHelp }: { audio: NotificationAudio; setEnabled(value: boolean): void; inlineHelp: boolean }) {
  const state = useSyncExternalStore(audio.subscribe, audio.getSnapshot, audio.getSnapshot);
  const Icon = state.enabled ? Volume2 : VolumeX;
  const label = state.enabled ? 'Sound On' : 'Muted';
  return <div className="notification-audio-control" data-notification-audio-control="true" data-inline-help={inlineHelp || undefined}>
    <Button size="sm" variant="ghost" aria-label={`Notification sounds: ${label}`} aria-pressed={state.enabled}
      title={state.enabled ? 'Mute notification sounds' : 'Turn on notification sounds'} onClick={() => setEnabled(!state.enabled)} leadingIcon={<Icon size={18} aria-hidden="true" />}>
      <span className="notification-audio-label">{label}</span>
    </Button>
    {state.enabled && (state.status === 'blocked' || state.status === 'unavailable') && <div className="notification-audio-help">
      <p role="status">{state.status === 'unavailable' ? 'Notification audio is unavailable in this browser.' : 'Your browser needs a user interaction to enable notification audio.'}</p>
      {state.status === 'blocked' && <Button size="sm" variant="outline" onClick={() => void audio.unlock()}>Enable sound</Button>}
    </div>}
  </div>;
}
