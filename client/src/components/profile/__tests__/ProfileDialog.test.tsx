import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProfileDialog } from '../ProfileDialog';
import { ProfileAvatar } from '../ProfileAvatar';
import { createDemoProfile } from '@/profiles/profileModel';
import type { ProfileUpdates } from '@/profiles/profileModel';
import { ThemeProvider, THEME_STORAGE_KEY } from '@/theme';

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement) { this.removeAttribute('open'); },
  });
});

afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

function ProfileHarness({ save = async () => true }: { save?: (updates: ProfileUpdates) => Promise<boolean> }) {
  const [profile, setProfile] = useState(createDemoProfile);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open my profile</button>
      <ProfileDialog
        open={open}
        onOpenChange={setOpen}
        profile={profile}
        isLoading={false}
        isSaving={false}
        error={null}
        onRetry={() => undefined}
        onSave={async (updates) => {
          const accepted = await save(updates);
          if (accepted) setProfile((current) => ({ ...current, ...updates }));
          return accepted;
        }}
      />
    </>
  );
}

function openProfile() {
  const opener = screen.getByRole('button', { name: 'Open my profile' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole('dialog', { name: 'Your profile' }) };
}

describe('ProfileDialog', () => {
  test('shows the local identity and restores focus after Escape closes the profile', () => {
    render(<ProfileHarness />);
    const { opener, dialog } = openProfile();
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: 'Demo Explorer' })).toBeInTheDocument();
    expect(within(dialog).getByText('Local demo identity')).toBeInTheDocument();
    expect(within(dialog).getByText('local-user')).toBeInTheDocument();
    expect(within(dialog).getAllByText('@demo-explorer')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Close profile' })).toHaveFocus();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).not.toHaveAttribute('open');
    expect(opener).toHaveFocus();
  });

  test('ignores a queued native close event after immediate reopen and preserves focus', async () => {
    render(<ProfileHarness />);
    const { opener, dialog } = openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
    expect(dialog).not.toHaveAttribute('open');
    expect(opener).toHaveFocus();

    openProfile();
    const closeButton = screen.getByRole('button', { name: 'Close profile' });
    expect(closeButton).toHaveFocus();
    await act(async () => {
      await Promise.resolve();
      fireEvent(dialog, new Event('close'));
    });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    expect(closeButton).toHaveFocus();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).not.toHaveAttribute('open');
    expect(opener).toHaveFocus();
  });

  test('validates required fields accessibly without discarding the input', () => {
    const save = jest.fn(async () => true);
    render(<ProfileHarness save={save} />);
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    const name = screen.getByRole('textbox', { name: 'Display name' });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(name).toHaveValue('   ');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Display name is required.');
    expect(name).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
  });

  test('saves normalized Unicode identity, avatar, and local presence fields', async () => {
    const save = jest.fn(async () => true);
    render(<ProfileHarness save={save} />);
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: '  Zoë ✨  ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Status message' }), { target: { value: '  Building 🚀  ' } });
    const rocket = screen.getByRole('radio', { name: 'Rocket' });
    fireEvent.click(rocket);
    expect(rocket).toBeChecked();
    expect(rocket).toHaveAccessibleDescription('Choose a look for your local profile.');
    expect(screen.getByRole('radio', { name: 'Initials' })).not.toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    fireEvent.change(screen.getByRole('combobox', { name: 'Presence preference' }), { target: { value: 'busy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Zoë ✨' })).toBeInTheDocument());
    expect(save).toHaveBeenCalledWith({
      displayName: 'Zoë ✨', statusMessage: 'Building 🚀', avatar: 'rocket', presencePreference: 'busy',
    });
    expect(screen.getByText('Building 🚀')).toBeInTheDocument();
    expect(screen.getByText('Busy')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Zoë ✨, Rocket avatar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toHaveFocus();
  });

  test('Cancel and close discard unsaved edits', () => {
    const save = jest.fn(async () => true);
    render(<ProfileHarness save={save} />);
    openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Discard me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Demo Explorer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue('Demo Explorer');

    fireEvent.change(screen.getByRole('textbox', { name: 'Status message' }), { target: { value: 'Discard this too' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
    openProfile();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    expect(screen.queryByText('Discard this too')).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  test('locks duplicate submissions and preserves changes when the service fails', async () => {
    let finishSave: (accepted: boolean) => void = () => undefined;
    const save = jest.fn(() => new Promise<boolean>((resolve) => { finishSave = resolve; }));
    render(<ProfileHarness save={save} />);
    const { dialog } = openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    const name = screen.getByRole('textbox', { name: 'Display name' });
    fireEvent.change(name, { target: { value: 'Keep my edits' } });
    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close profile' })).toBeDisabled();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).toHaveAttribute('open');

    await act(async () => { finishSave(false); });
    expect(screen.getByRole('alert')).toHaveTextContent('Your changes are still here.');
    expect(name).toHaveValue('Keep my edits');
    expect(saveButton).toBeEnabled();
  });

  test('shows a retry action when loading the local profile fails', () => {
    const retry = jest.fn();
    render(<ProfileDialog open onOpenChange={jest.fn()} profile={null} isLoading={false} isSaving={false}
      error="Your local demo profile could not be loaded." onRetry={retry} onSave={async () => false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Your local demo profile could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('applies appearance independently of profile Save and Cancel without adding identity fields', async () => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    const save = jest.fn(async (_updates: ProfileUpdates) => true);
    render(<ThemeProvider><ProfileHarness save={save} /></ThemeProvider>);
    try {
      const { opener } = openProfile();
      fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(save).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
      expect(screen.queryByRole('group', { name: 'Appearance' })).not.toBeInTheDocument();
      fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Discard this identity' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('heading', { name: 'Demo Explorer' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(save).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Theme Explorer' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Theme Explorer' })).toBeInTheDocument());
      expect(save).toHaveBeenCalledWith({
        displayName: 'Theme Explorer',
        statusMessage: 'Exploring the local demo',
        avatar: 'initials',
        presencePreference: 'available',
      });
      expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
      expect(opener).toHaveFocus();
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    } finally {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = '';
    }
  });
});

test('ProfileAvatar uses local initials and fixed icon presets without remote images', () => {
  const { rerender } = render(<ProfileAvatar displayName="Demo Explorer" avatar="initials" />);
  expect(screen.getByRole('img', { name: 'Demo Explorer' })).toHaveTextContent('DE');
  rerender(<ProfileAvatar displayName="Demo Explorer" avatar="cat" />);
  expect(screen.getByRole('img', { name: 'Demo Explorer, Cat avatar' })).toBeInTheDocument();
  expect(document.querySelector('img')).not.toBeInTheDocument();
});

test('ProfileAvatar keeps astral Unicode characters intact in initials', () => {
  render(<ProfileAvatar displayName="Nova 🦉" avatar="initials" />);
  expect(screen.getByRole('img', { name: 'Nova 🦉' })).toHaveTextContent('N🦉');
});
