import { render, screen } from '@testing-library/react';
import { CallEventBubble } from '@/components/calls/CallEventBubble';
import type { DirectCallSummary } from '../directCallHistory';

const summary: DirectCallSummary = { id: 'call-1', conversationId: 'dm-1', kind: 'voice', endedAt: 353000,
  durationMs: 332000, outcome: 'completed', confirmed: true };

test.each(['voice', 'video'] as const)('a compact %s call bubble shows duration, timestamp and session-only description', kind => {
  const { container } = render(<CallEventBubble call={{ ...summary, kind }} />);
  const bubble = screen.getByRole('note', { name: `${kind === 'video' ? 'Video' : 'Voice'} call · 05:32` });
  expect(bubble).toHaveAccessibleDescription(/not saved after reload or sign-out/);
  expect(bubble.querySelector('time')).toHaveAttribute('dateTime', new Date(summary.endedAt).toISOString());
  expect(bubble.querySelector('time')).toHaveTextContent(new Date(summary.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  expect(container.querySelector('details, summary, button, [data-message-id]')).toBeNull();
});

test.each(['missed', 'rejected', 'canceled'] as const)('%s calls have an outcome label without a completed duration', outcome => {
  render(<CallEventBubble call={{ ...summary, outcome, durationMs: null }} />);
  expect(screen.getByRole('note')).toHaveTextContent(`Voice call · ${outcome[0]!.toUpperCase()}${outcome.slice(1)}`);
  expect(screen.getByRole('note')).not.toHaveTextContent('05:32');
});

test('unknown duration and unconfirmed end are explicit instead of an invented completed call', () => {
  render(<CallEventBubble call={{ ...summary, durationMs: null, outcome: 'ended', confirmed: false }} />);
  expect(screen.getByRole('note')).toHaveTextContent('duration unavailable on this device');
  expect(screen.getByRole('note')).toHaveTextContent('End not confirmed');
});

test('summaries start no timers and conversation navigation/unmount leaves none behind', () => {
  jest.useFakeTimers();
  try {
    const view = render(<CallEventBubble call={summary} />); expect(jest.getTimerCount()).toBe(0);
    view.rerender(<CallEventBubble call={{ ...summary, id: 'other', conversationId: 'other' }} />); expect(jest.getTimerCount()).toBe(0);
    view.unmount(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
