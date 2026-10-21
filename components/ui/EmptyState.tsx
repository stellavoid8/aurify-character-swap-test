import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-4 px-4 py-10 text-center', className)}>
      {icon && (
        <div aria-hidden className="flex size-14 items-center justify-center rounded-pill bg-surface-2 text-ink-muted [&>svg]:size-6">
          {icon}
        </div>
      )}
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="font-display text-title">{title}</h2>
        {body && <p className="text-body text-ink-muted">{body}</p>}
      </div>
      {action}
    </div>
  );
}
