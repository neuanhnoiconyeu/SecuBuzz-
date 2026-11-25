import { useCallback, useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useAnchoredMessagePopover } from '../useAnchoredMessagePopover';

function Popup({ expanded = false }: { expanded?: boolean }) {
  const [open, setOpen] = useState(false), [disabled, setDisabled] = useState(false);
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useAnchoredMessagePopover(panel, trigger, open ? 'test' : null, close, expanded);
  return <><fieldset disabled={disabled}><button ref={trigger} onClick={() => setOpen(!open)}>Open</button>
    {open && <div ref={panel} role="dialog" aria-label="Popup"><button>Choice</button></div>}</fieldset>
    <button onClick={() => setDisabled(true)}>Disable</button></>;
}
const rectangle = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height }) as DOMRect;
const originalShow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');
const originalHide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover');
const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
afterEach(() => {
  jest.restoreAllMocks();
  for (const [name, descriptor] of [['showPopover', originalShow], ['hidePopover', originalHide]] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport); else Reflect.deleteProperty(window, 'visualViewport');
});

test('native top-layer positioning clamps to the viewport, responds to mobile keyboard resizing and cleans up', () => {
  const show = jest.fn(), hide = jest.fn();
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: show });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: hide });
  const viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 320, height: 500 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.getAttribute('role') === 'dialog' ? rectangle(0, 0, 292, 368) : rectangle(280, 450, 40, 40);
  });
  // The popup's entry animation scales its visible rectangle, but layout size stays fixed.
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(304);
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(384);
  const { unmount } = render(<Popup expanded />);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  const panel = screen.getByRole('dialog');
  expect(show).toHaveBeenCalledTimes(1); expect(panel).toHaveAttribute('popover', 'manual');
  expect(panel).toHaveStyle({ position: 'fixed', left: '8px', top: '58px', maxWidth: '304px', maxHeight: '484px' });
  act(() => { viewport.height = 350; viewport.dispatchEvent(new Event('resize')); });
  expect(panel).toHaveStyle({ top: '8px', maxHeight: '334px' });
  // The top layer does not portal actions outside the disabled conversation fieldset.
  fireEvent.click(screen.getByRole('button', { name: 'Disable' })); expect(screen.getByRole('button', { name: 'Choice' })).toBeDisabled();
  unmount(); expect(hide).toHaveBeenCalledTimes(1); expect(panel).not.toHaveAttribute('popover');
  act(() => viewport.dispatchEvent(new Event('resize'))); expect(hide).toHaveBeenCalledTimes(1);
});

test('legacy browsers without the top layer still dismiss outside interactions and Escape', () => {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: undefined });
  render(<Popup />);
  fireEvent.click(screen.getByRole('button', { name: 'Open' })); expect(screen.getByRole('dialog')).not.toHaveAttribute('popover');
  fireEvent.pointerDown(document.body); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open' })); fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
