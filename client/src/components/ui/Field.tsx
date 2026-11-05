import React, { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx, mergeIds } from './utils';

interface FieldMessages {
  label: string;
  hint?: string;
  error?: string;
  success?: string;
  inputClassName?: string;
}

export type TextInputType = 'text' | 'email' | 'password' | 'search' | 'url' | 'tel' | 'number';

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'>,
    FieldMessages {
  type?: TextInputType;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    className,
    error,
    hint,
    id,
    inputClassName,
    label,
    success,
    type = 'text',
    ...props
  },
  ref
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const successId = `${inputId}-success`;
  const descriptionId = error ? errorId : success ? successId : hint ? hintId : undefined;

  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field-label" htmlFor={inputId}>{label}</label>
      <input
        {...props}
        ref={ref}
        id={inputId}
        type={type}
        className={cx('ui-input', error && 'ui-input--error', success && !error && 'ui-input--success', inputClassName)}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={mergeIds(props['aria-describedby'], descriptionId)}
      />
      {error ? <p className="ui-field-message ui-field-message--error" id={errorId}>{error}</p> : null}
      {!error && success ? <p className="ui-field-message ui-field-message--success" id={successId}>{success}</p> : null}
      {!error && !success && hint ? <p className="ui-field-message" id={hintId}>{hint}</p> : null}
    </div>
  );
});

TextInput.displayName = 'TextInput';

export interface TextAreaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    FieldMessages {}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    className,
    error,
    hint,
    id,
    inputClassName,
    label,
    success,
    ...props
  },
  ref
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const successId = `${inputId}-success`;
  const descriptionId = error ? errorId : success ? successId : hint ? hintId : undefined;

  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field-label" htmlFor={inputId}>{label}</label>
      <textarea
        {...props}
        ref={ref}
        id={inputId}
        className={cx('ui-input ui-textarea', error && 'ui-input--error', success && !error && 'ui-input--success', inputClassName)}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={mergeIds(props['aria-describedby'], descriptionId)}
      />
      {error ? <p className="ui-field-message ui-field-message--error" id={errorId}>{error}</p> : null}
      {!error && success ? <p className="ui-field-message ui-field-message--success" id={successId}>{success}</p> : null}
      {!error && !success && hint ? <p className="ui-field-message" id={hintId}>{hint}</p> : null}
    </div>
  );
});

TextArea.displayName = 'TextArea';
