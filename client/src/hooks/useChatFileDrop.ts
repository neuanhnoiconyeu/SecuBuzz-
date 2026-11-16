import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

export function useChatFileDrop(scope: string, enabled: boolean) {
  const [batch, setBatch] = useState<{ scope: string; files: readonly File[] }>();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => { setBatch(undefined); setDragging(false); depth.current = 0; }, [scope]);
  const isFileDrag = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes('Files');
  const available = (event: DragEvent<HTMLElement>) => enabled && !event.currentTarget.closest('fieldset[disabled]');
  return { files: batch?.scope === scope ? batch.files : undefined, dragging, bind: {
    onDragEnter(event: DragEvent<HTMLElement>) {
      if (!isFileDrag(event)) return;
      event.preventDefault(); depth.current += 1;
      if (available(event)) setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!isFileDrag(event)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = available(event) ? 'copy' : 'none';
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!isFileDrag(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!isFileDrag(event)) return;
      event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false);
      if (available(event) && event.dataTransfer.files.length) setBatch({ scope, files: Array.from(event.dataTransfer.files) });
    },
  } };
}
