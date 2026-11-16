import { act, renderHook } from '@testing-library/react';
import type { DragEvent } from 'react';
import { useChatFileDrop } from '../useChatFileDrop';

test('never passes the previous conversation’s dropped files into a newly mounted composer', () => {
  const observations: Array<{ scope: string; hasFiles: boolean }> = [];
  const { result, rerender } = renderHook(({ scope }) => {
    const drop = useChatFileDrop(scope, true);
    observations.push({ scope, hasFiles: Boolean(drop.files?.length) });
    return drop;
  }, { initialProps: { scope: 'room-a' } });
  const event = { dataTransfer: { types: ['Files'], files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    currentTarget: document.createElement('section'), preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as DragEvent<HTMLElement>;
  act(() => result.current.bind.onDrop(event));
  expect(result.current.files).toHaveLength(1);
  rerender({ scope: 'room-b' });
  expect(observations.filter((observation) => observation.scope === 'room-b').every((observation) => !observation.hasFiles)).toBe(true);
  expect(event.preventDefault).toHaveBeenCalled();
});
