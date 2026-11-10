import { act, fireEvent, render, screen } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';

test('a slow acknowledgement cannot erase a newer draft; typing stops on blur and submission', async () => {
  let resolve!: (accepted: boolean) => void;
  const onSend = jest.fn(() => new Promise<boolean>((done) => { resolve = done; }));
  const onTypingActivity = jest.fn(), onTypingStop = jest.fn();
  render(<MessageComposer conversationName="Peer" messageCount={0} isSending={false} buzzBusy={false}
    onSend={onSend} onBuzz={jest.fn()} onTypingActivity={onTypingActivity} onTypingStop={onTypingStop} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' });
  fireEvent.change(input, { target: { value: 'first draft' } });
  expect(onTypingActivity).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onTypingStop).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: 'next draft' } });
  await act(async () => { resolve(true); });
  expect(input).toHaveValue('next draft'); expect(onSend).toHaveBeenCalledTimes(1);
  fireEvent.blur(input); expect(onTypingStop).toHaveBeenCalledTimes(2);
  fireEvent.change(input, { target: { value: '' } }); expect(onTypingStop).toHaveBeenCalledTimes(3);
});
