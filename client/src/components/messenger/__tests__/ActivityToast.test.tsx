import { act, fireEvent, render, screen } from '@testing-library/react';
import { ActivityToast } from '../ActivityToast';

beforeEach(() => jest.useFakeTimers()); afterEach(() => jest.useRealTimers());
const props = () => ({ id: 'one', text: 'New message from Bob', kind: 'message' as const, onDismiss: jest.fn() });

test('generic notices use an overlay, expose keyboard controls and expire without system permissions', () => {
  const p = props(), open = jest.fn(); const { container, unmount } = render(<ActivityToast {...p} onOpen={open} />);
  expect(container).toBeEmptyDOMElement(); // Portal cannot consume header/history layout space.
  expect(screen.getByRole('status', { name: 'Message notification' })).toHaveTextContent('New message from Bob');
  expect(screen.queryByText(/ciphertext|attachment|private message content/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View conversation' })); expect(open).toHaveBeenCalledTimes(1);
  expect(p.onDismiss).toHaveBeenCalledTimes(1);
  unmount(); expect(jest.getTimerCount()).toBe(0);
});

test('expiry restarts for a new event and cleans up on unmount', () => {
  const p = props(); const view = render(<ActivityToast {...p} />);
  act(() => jest.advanceTimersByTime(4000)); expect(p.onDismiss).not.toHaveBeenCalled();
  view.rerender(<ActivityToast {...p} id="two" />);
  act(() => jest.advanceTimersByTime(4000)); expect(p.onDismiss).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1000)); expect(p.onDismiss).toHaveBeenCalledTimes(1);
  view.unmount(); expect(jest.getTimerCount()).toBe(0);
});

test('focus and hover pause the brief notice so it cannot disappear during keyboard interaction', () => {
  const p = props(); render(<ActivityToast {...p} />);
  const notice = screen.getByRole('complementary', { name: 'Incoming activity' });
  fireEvent.mouseEnter(notice); act(() => jest.advanceTimersByTime(6000)); expect(p.onDismiss).not.toHaveBeenCalled();
  fireEvent.mouseLeave(notice); const button = screen.getByRole('button', { name: 'Dismiss notification' });
  act(() => button.focus()); act(() => jest.advanceTimersByTime(6000)); expect(p.onDismiss).not.toHaveBeenCalled();
  fireEvent.click(button); expect(p.onDismiss).toHaveBeenCalledTimes(1);
});

test('hidden documents pause expiry and Buzz keeps its visible, accessible notification', () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const p = props(); render(<ActivityToast {...p} kind="buzz" text="Bob sent you a BUZZ!" />);
    expect(screen.getByRole('status', { name: 'Buzz notification' })).toHaveTextContent('BUZZ!');
    act(() => jest.advanceTimersByTime(6000)); expect(p.onDismiss).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => jest.advanceTimersByTime(5000)); expect(p.onDismiss).toHaveBeenCalledTimes(1);
  } finally { if (descriptor) Object.defineProperty(document, 'hidden', descriptor); else Reflect.deleteProperty(document, 'hidden'); }
});

test('a new notice resumes expiry if its predecessor removed a focused action', () => {
  const p = props(); const view = render(<ActivityToast {...p} onOpen={jest.fn()} />);
  act(() => screen.getByRole('button', { name: 'View conversation' }).focus());
  view.rerender(<ActivityToast {...p} id="buzz" kind="buzz" text="Bob sent you a BUZZ!" />);
  act(() => jest.advanceTimersByTime(5000));
  expect(p.onDismiss).toHaveBeenCalledTimes(1);
});
