import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageList } from '../MessageList';
import { MessageComposer } from '../MessageComposer';
import type { ChatMessage } from '@/messaging/messageModel';
import { REAL_ACCOUNT_MESSAGING_CAPABILITIES } from '@/messaging/messagingCapabilities';

const baseTime = '2026-11-25T03:00:00.000Z';
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});

afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    conversationId: 'conv-1',
    senderId: 'self',
    senderName: 'Alice',
    content: '',
    timestamp: baseTime,
    type: 'text',
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

describe('Messenger-style message wrappers and Send button', () => {
  test('renders emoji-only messages with bare bubble class and preserves text bubbles', () => {
    const emojiMsg = makeMessage({ id: 'emoji-1', content: '👍' });
    const textMsg = makeMessage({ id: 'text-1', content: 'Hello world', senderId: 'peer', senderName: 'Bob' });

    const { container } = render(
      <MessageList
        messages={[emojiMsg, textMsg]}
        currentUserId="self"
        currentUserName="Alice"
        onRetryMessage={jest.fn()}
      />,
    );

    const emojiRow = container.querySelector('[data-message-id="emoji-1"]')!;
    expect(emojiRow).toHaveClass('message-row-outgoing');
    expect(emojiRow.querySelector('.message-bubble--bare')).toBeInTheDocument();
    expect(emojiRow.querySelector('.message-text--emoji')).toHaveTextContent('👍');

    const textRow = container.querySelector('[data-message-id="text-1"]')!;
    expect(textRow).not.toHaveClass('message-row-outgoing');
    const textBubble = textRow.querySelector('.message-bubble')!;
    expect(textBubble).toBeInTheDocument();
    expect(textBubble).not.toHaveClass('message-bubble--bare');
    expect(textBubble).toHaveTextContent('Hello world');
  });

  test('renders voice messages without outer message-bubble wrapper while preserving controls', () => {
    const voiceMsg = makeMessage({
      id: 'voice-1',
      type: 'voice',
      content: '',
      voice: { audioUrl: 'blob:voice-1', durationSeconds: 5 },
    });

    const { container } = render(
      <MessageList
        messages={[voiceMsg]}
        currentUserId="self"
        currentUserName="Alice"
        onRetryMessage={jest.fn()}
      />,
    );

    const row = container.querySelector('[data-message-id="voice-1"]')!;
    expect(row).toHaveClass('message-row-outgoing');
    expect(row.querySelector('.message-bubble')).not.toBeInTheDocument();
    expect(row.querySelector('.voice-message-card')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice message from Alice')).toHaveAttribute('controls');
    expect(within(row as HTMLElement).getByText('5s')).toBeInTheDocument();
  });

  test('renders PDF, image, and video attachments without outer message-bubble wrapper', () => {
    const pdfMsg = makeMessage({
      id: 'pdf-1',
      senderId: 'peer',
      senderName: 'Bob',
      attachments: [{ id: 'a1', name: 'spec.pdf', type: 'file', url: 'blob:pdf', sizeBytes: 2048, mimeType: 'application/pdf' }],
    });
    const imgMsg = makeMessage({
      id: 'img-1',
      attachments: [{ id: 'a2', name: 'photo.png', type: 'image', url: 'blob:img', sizeBytes: 4096, mimeType: 'image/png' }],
    });
    const vidMsg = makeMessage({
      id: 'vid-1',
      attachments: [{ id: 'a3', name: 'clip.mp4', type: 'video', url: 'blob:vid', sizeBytes: 8192, mimeType: 'video/mp4' }],
    });

    const { container } = render(
      <MessageList
        messages={[pdfMsg, imgMsg, vidMsg]}
        currentUserId="self"
        onRetryMessage={jest.fn()}
      />,
    );

    const pdfRow = container.querySelector('[data-message-id="pdf-1"]')!;
    expect(pdfRow).not.toHaveClass('message-row-outgoing');
    expect(pdfRow.querySelector('.message-bubble')).not.toBeInTheDocument();
    expect(pdfRow.querySelector('.message-attachment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download spec.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview spec.pdf' })).toBeInTheDocument();

    const imgRow = container.querySelector('[data-message-id="img-1"]')!;
    expect(imgRow).toHaveClass('message-row-outgoing');
    expect(imgRow.querySelector('.message-bubble')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'photo.png' })).toBeInTheDocument();

    const vidRow = container.querySelector('[data-message-id="vid-1"]')!;
    expect(vidRow.querySelector('.message-bubble')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Video: clip.mp4')).toHaveAttribute('controls');
  });

  test('renders mixed text and attachment without double-wrapping the attachment card', () => {
    const mixedMsg = makeMessage({
      id: 'mixed-1',
      content: 'See attached document',
      attachments: [{ id: 'a4', name: 'notes.pdf', type: 'file', url: 'blob:notes', sizeBytes: 512, mimeType: 'application/pdf' }],
    });

    const { container } = render(
      <MessageList
        messages={[mixedMsg]}
        currentUserId="self"
        onRetryMessage={jest.fn()}
      />,
    );

    const row = container.querySelector('[data-message-id="mixed-1"]')!;
    const bubble = row.querySelector('.message-bubble')!;
    const attachmentCard = row.querySelector('.message-attachment')!;
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveTextContent('See attached document');
    expect(attachmentCard).toBeInTheDocument();
    expect(bubble.contains(attachmentCard)).toBe(false);
  });

  test('preserves Reply, Reaction, Edit, Unsend, and Forward actions on unwrapped messages', () => {
    const textMsg = makeMessage({ id: 'act-text', content: 'Editable message' });
    const fileMsg = makeMessage({
      id: 'act-file',
      attachments: [{ id: 'a5', name: 'report.pdf', type: 'file', url: 'blob:rep', sizeBytes: 1024, mimeType: 'application/pdf' }],
    });

    const { container } = render(
      <MessageList
        messages={[textMsg, fileMsg]}
        currentUserId="self"
        capabilities={REAL_ACCOUNT_MESSAGING_CAPABILITIES}
        transportMode="realtime"
        onRetryMessage={jest.fn()}
        onReplyMessage={jest.fn()}
        onToggleReaction={jest.fn()}
        onEditMessage={jest.fn()}
        onUnsendMessage={jest.fn()}
        onForwardMessage={jest.fn()}
      />,
    );

    const fileRow = container.querySelector('[data-message-id="act-file"]') as HTMLElement;
    expect(within(fileRow).getByRole('button', { name: 'React to message' })).toBeInTheDocument();
    expect(within(fileRow).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    fireEvent.click(within(fileRow).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Forward' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /Delete for everyone/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const textRow = container.querySelector('[data-message-id="act-text"]') as HTMLElement;
    fireEvent.click(within(textRow).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
  });

  test('renders all emoji-only messages bare with one uniform per-emoji size while keeping mixed text in a bubble', () => {
    const soloEmoji = makeMessage({ id: 'e-solo', content: '😍', senderId: 'peer', senderName: 'Bob' });
    const twoEmojis = makeMessage({ id: 'e-two', content: '👍🏽👍🏻', senderId: 'peer', senderName: 'Bob' });
    const threeEmojis = makeMessage({ id: 'e-three', content: '👍❤️😂' });
    const fourEmojis = makeMessage({ id: 'e-four', content: '😍😍😍😍' });
    const longEmojis = makeMessage({ id: 'e-long', content: '😍'.repeat(18) });
    const family = makeMessage({ id: 'e-zwj', content: '👨👩👧👦😍😍' });
    const flags = makeMessage({ id: 'e-flags', content: '🇫🇷🇻🇳' });
    const mixedText = makeMessage({ id: 'mixed-text', content: 'Love this 😍😍😍' });
    const numbersOnly = makeMessage({ id: 'numbers', content: '12345' });

    const { container } = render(
      <MessageList
        messages={[soloEmoji, twoEmojis, threeEmojis, fourEmojis, longEmojis, family, flags, mixedText, numbersOnly]}
        currentUserId="self"
        onRetryMessage={jest.fn()}
      />,
    );

    for (const id of ['e-solo', 'e-two', 'e-three', 'e-four', 'e-long', 'e-zwj', 'e-flags']) {
      const r = container.querySelector(`[data-message-id="${id}"]`)!;
      expect(r.querySelector('.message-bubble--bare')).toBeInTheDocument();
      const span = r.querySelector('.message-text--emoji')!;
      expect(span).toBeInTheDocument();
      expect(span).not.toHaveClass('message-text--emoji-solo', 'message-text--emoji-group');
      expect(span).not.toHaveAttribute('data-emoji-count');
      expect(span).not.toHaveAttribute('data-emoji-tier');
    }

    for (const id of ['mixed-text', 'numbers']) {
      const r = container.querySelector(`[data-message-id="${id}"]`)!;
      expect(r.querySelector('.message-bubble')).toBeInTheDocument();
      expect(r.querySelector('.message-bubble--bare')).not.toBeInTheDocument();
      expect(r.querySelector('.message-text--emoji')).not.toBeInTheDocument();
    }

    const reactionsCss = fs.readFileSync(path.join(process.cwd(), 'src/components/messenger/message-reactions.css'), 'utf8');
    expect(reactionsCss).toContain('--emoji-standalone-size');
    expect(reactionsCss).not.toContain('--emoji-solo-size');
    expect(reactionsCss).not.toContain('--emoji-group-size');
    expect(reactionsCss).not.toContain('data-emoji-count');
  });

  test('renders multi-emoji bare messages, forwarded standalone media, and dark/theme CSS rules', () => {
    const multiEmoji = makeMessage({ id: 'multi-emoji', content: '🎉🔥', senderId: 'peer', senderName: 'Bob' });
    const forwardedMedia = makeMessage({
      id: 'fwd-img',
      forwardedFrom: 'Charlie',
      attachments: [{ id: 'a6', name: 'snap.jpg', type: 'image', url: 'blob:snap', sizeBytes: 1024, mimeType: 'image/jpeg' }],
    });
    const { container } = render(
      <MessageList
        messages={[multiEmoji, forwardedMedia]}
        currentUserId="self"
        onRetryMessage={jest.fn()}
      />,
    );
    const emojiRow = container.querySelector('[data-message-id="multi-emoji"]')!;
    expect(emojiRow.querySelector('.message-bubble--bare')).toBeInTheDocument();
    expect(emojiRow.querySelector('.message-text--emoji')).toBeInTheDocument();

    const fwdRow = container.querySelector('[data-message-id="fwd-img"]')!;
    expect(fwdRow.querySelector('.message-bubble')).not.toBeInTheDocument();
    expect(fwdRow.querySelector('.message-forwarded-label--standalone')).toHaveTextContent('Forwarded from Charlie');

    const globalsCss = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(globalsCss).toMatch(/\.message-bubble\.message-bubble--bare[\s\S]*background:\s*transparent/);
    expect(globalsCss).toMatch(/\.composer-dock \.composer-send[\s\S]*border-radius:\s*50%;\s*background:\s*transparent/);
  });

  test('renders minimal ghost Send icon button with Enter-to-send and disabled state preserved', async () => {
    const onSend = jest.fn(async () => true);
    render(
      <MessageComposer
        conversationName="Bob"
        messageCount={0}
        isSending={false}
        buzzBusy={false}
        quickEmoji="👍"
        onSend={onSend}
      />,
    );

    const quick = screen.getByRole('button', { name: 'Send 👍' });
    expect(quick).toHaveClass('ui-button--ghost', 'composer-quick-emoji');

    const input = screen.getByRole('textbox', { name: 'Message to Bob' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 👍' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Hi Bob' } });
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect(sendBtn).toHaveClass('ui-button--ghost', 'composer-send');
    expect(sendBtn).not.toHaveClass('ui-button--primary');
    expect(sendBtn).toBeEnabled();

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi Bob'));
    await waitFor(() => expect(input).toHaveValue(''));
  });
});
