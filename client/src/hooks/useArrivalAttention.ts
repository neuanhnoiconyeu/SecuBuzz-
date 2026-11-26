import { useEffect, useRef, useState } from 'react';

export const ARRIVAL_ATTENTION_MS = 650;
/** One brief presentation effect per invitation; reconnects/revisions cannot restart it. */
export function useArrivalAttention(id: string | null, enabled: boolean) {
  const seen = useRef(new Set<string>());
  const [attention, setAttention] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !enabled || seen.current.has(id)) { setAttention(null); return; }
    seen.current.add(id);
    if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value!);
    setAttention(id);
    const timer = setTimeout(() => setAttention(null), ARRIVAL_ATTENTION_MS);
    return () => clearTimeout(timer);
  }, [id, enabled]);
  return enabled && id !== null && attention === id;
}
