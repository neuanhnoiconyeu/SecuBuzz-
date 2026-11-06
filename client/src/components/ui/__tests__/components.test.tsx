import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { Avatar, Badge, Button, Dialog, DropdownMenu, Surface, TextArea, TextInput, Tooltip } from '..';

describe('shared UI components', () => {
  test('Button exposes its variant, loading state, and disabled behavior', () => {
    render(
      <>
        <Button variant="primary">Save profile</Button>
        <Button loading>Sending message</Button>
        <Button variant="danger" retro>BUZZ</Button>
      </>
    );

    expect(screen.getByRole('button', { name: 'Save profile' })).toHaveClass('ui-button--primary');
    expect(screen.getByRole('button', { name: 'Sending message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sending message' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'BUZZ' })).toHaveClass('nes-btn', 'is-error');
  });

  test('TextInput connects its label and validation message accessibly', () => {
    render(<TextInput label="Email address" type="email" error="Enter a valid email." />);

    const input = screen.getByRole('textbox', { name: 'Email address' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email.');
  });

  test('TextArea connects its helper text to the control', () => {
    render(<TextArea label="Message" hint="Keep it short." />);

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAccessibleDescription('Keep it short.');
  });

  test('DropdownMenu supports arrow navigation, selection, and Escape', () => {
    const onSelect = jest.fn();
    render(
      <DropdownMenu
        label="Conversation actions"
        items={[
          { id: 'profile', label: 'View profile', onSelect },
          { id: 'mute', label: 'Mute conversation', onSelect },
        ]}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Conversation actions' });
    fireEvent.click(trigger);
    const firstItem = screen.getByRole('menuitem', { name: 'View profile' });
    const secondItem = screen.getByRole('menuitem', { name: 'Mute conversation' });
    expect(firstItem).toHaveFocus();

    fireEvent.keyDown(firstItem, { key: 'ArrowDown' });
    expect(secondItem).toHaveFocus();
    fireEvent.keyDown(secondItem, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View profile' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test('Dialog opens modally and closes through its accessible close control', () => {
    const oldShowModal = HTMLDialogElement.prototype.showModal;
    const oldClose = HTMLDialogElement.prototype.close;
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function close(this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      },
    });

    function DialogHarness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open settings</Button>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Conversation settings"
            description="Manage this conversation."
            footer={<Button onClick={() => setOpen(false)}>Done</Button>}
          >
            Settings content
          </Dialog>
        </>
      );
    }

    try {
      render(<DialogHarness />);
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      const dialog = screen.getByRole('dialog', { name: 'Conversation settings' });
      expect(dialog).toHaveAttribute('open');
      expect(dialog).toHaveAccessibleDescription('Manage this conversation.');
      expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
      expect(dialog).not.toHaveAttribute('open');
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(dialog).not.toHaveAttribute('open');
    } finally {
      if (oldShowModal) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: oldShowModal });
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
      }
      if (oldClose) {
        Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: oldClose });
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
      }
    }
  });

  test('Tooltip trigger describes its help text and Avatar exposes fallback initials', () => {
    render(
      <>
        <Tooltip label="More information" content="Encrypted in this browser." />
        <Avatar name="Secure Bot" status="online" />
      </>
    );

    expect(screen.getByRole('button', { name: 'More information' })).toHaveAccessibleDescription('Encrypted in this browser.');
    expect(screen.getByRole('img', { name: 'Secure Bot, online' })).toHaveTextContent('SB');
  });

  test('Badge announces changing status and Surface supports its optional retro treatment', () => {
    render(
      <>
        <Badge status="away" announce>Away</Badge>
        <Surface variant="retro" data-testid="retro-surface">Retro accent</Surface>
      </>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Away');
    expect(screen.getByTestId('retro-surface')).toHaveClass('nes-container', 'is-rounded');
  });
});
