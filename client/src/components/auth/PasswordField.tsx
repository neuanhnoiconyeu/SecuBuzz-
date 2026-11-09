'use client';

import { forwardRef, useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { TextInput } from '@/components/ui';
import type { TextInputProps } from '@/components/ui';
import { mergeIds } from '@/components/ui/utils';

export interface PasswordFieldProps extends Omit<TextInputProps, 'type' | 'value'> {
  id: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField({
  autoComplete, disabled, id, label, onBlur, onKeyDown, onKeyUp, value, ...props
}, ref) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const capsId = `${id}-caps-lock`;

  useEffect(() => { if (!value) setVisible(false); }, [value]);

  return (
    <div className="auth-password-control">
      <TextInput {...props} ref={ref} id={id} label={label} value={value} disabled={disabled}
        type={visible ? 'text' : 'password'} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false}
        aria-describedby={mergeIds(props['aria-describedby'], capsLock ? capsId : undefined)}
        onKeyDown={(event) => {
          setCapsLock(event.getModifierState('CapsLock'));
          onKeyDown?.(event);
        }}
        onKeyUp={(event) => {
          setCapsLock(event.getModifierState('CapsLock'));
          onKeyUp?.(event);
        }}
        onBlur={(event) => { setCapsLock(false); onBlur?.(event); }} />
      <button type="button" className="auth-password-toggle" disabled={disabled}
        aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLocaleLowerCase()}`} aria-pressed={visible}
        aria-controls={id} onClick={() => setVisible((current) => !current)}>
        {visible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
      </button>
      {capsLock && <p id={capsId} role="status" className="auth-caps-lock">Caps Lock is on.</p>}
    </div>
  );
});
