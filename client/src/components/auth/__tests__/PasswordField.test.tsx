import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PasswordField } from '../PasswordField';

function Harness() {
  const [value, setValue] = useState('sample value');
  return <PasswordField id="test-password" label="Password" value={value} autoComplete="current-password"
    onChange={(event) => setValue(event.target.value)} error="Check your password." />;
}

test('password visibility is accessible and resets after sensitive values are cleared', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Password', { exact: true });
  expect(input).toHaveAttribute('type', 'password');
  expect(input).toHaveAccessibleDescription('Check your password.');
  const show = screen.getByRole('button', { name: 'Show password' });
  expect(show).toHaveAttribute('type', 'button');
  expect(show).toHaveAttribute('aria-controls', input.id);
  expect(show).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(show);
  expect(input).toHaveAttribute('type', 'text');
  expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(input, { target: { value: '' } });
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
});

test('Caps Lock feedback augments field errors and clears on blur', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Password', { exact: true });
  fireEvent.keyDown(input, { key: 'A', modifierCapsLock: true });
  expect(screen.getByRole('status')).toHaveTextContent('Caps Lock is on.');
  expect(input).toHaveAccessibleDescription('Caps Lock is on. Check your password.');
  fireEvent.blur(input);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(input).toHaveAccessibleDescription('Check your password.');
});
