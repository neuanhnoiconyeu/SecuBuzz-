import React, { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { cx } from './utils';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeLabel?: string;
  dismissible?: boolean;
}

export function Dialog({
  children,
  className,
  closeLabel = 'Close dialog',
  description,
  dismissible = true,
  footer,
  onOpenChange,
  open,
  title,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const openingControl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>(
      '[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
    )?.focus();

    return () => {
      if (dialog.open) dialog.close();
      if (openingControl?.isConnected) openingControl.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={cx('ui-dialog', className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onOpenChange(false);
      }}
      onClose={() => {
        // A queued close event may arrive after this native dialog has reopened.
        if (open && !dialogRef.current?.open) onOpenChange(false);
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className="ui-dialog-panel">
        <header className="ui-dialog-header">
          <div>
            <h2 id={titleId} className="ui-dialog-title display-heading display-heading--modal">{title}</h2>
            {description ? <p id={descriptionId} className="ui-dialog-description">{description}</p> : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ui-dialog-close"
            aria-label={closeLabel}
            disabled={!dismissible}
            onClick={() => onOpenChange(false)}
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer ? <footer className="ui-dialog-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

export default Dialog;
