import React, { useId } from 'react';
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

export interface TooltipProps {
  content: string;
  label: string;
  children?: ReactNode;
}

export function Tooltip({ children, content, label }: TooltipProps) {
  const id = useId();
  return (
    <span className="ui-tooltip">
      <button
        type="button"
        className="ui-tooltip-trigger"
        aria-label={label}
        aria-describedby={id}
      >
        {children ?? <Info size={16} aria-hidden="true" />}
      </button>
      <span id={id} role="tooltip" className="ui-tooltip-content">{content}</span>
    </span>
  );
}

export default Tooltip;
