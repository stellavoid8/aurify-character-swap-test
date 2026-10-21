'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Action buttons, rendered right-aligned (stacked on mobile). */
  footer?: ReactNode;
  className?: string;
};

/**
 * Modal built on native <dialog>: showModal() makes the page behind inert (focus stays inside),
 * Esc closes it, and focus returns to the opener on close.
 */
export function Dialog({ open, onClose, title, description, children, footer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Esc: let the parent own the open state.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the dialog element itself (not its content) is a backdrop click.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-md rounded-lg bg-surface p-0 text-ink shadow-card backdrop:bg-ink/50',
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="pt-2 text-heading">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-pill text-ink-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        {description && (
          <div id={descriptionId} className="text-body text-ink-muted">
            {description}
          </div>
        )}
        {children}
        {footer && <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">{footer}</div>}
      </div>
    </dialog>
  );
}
