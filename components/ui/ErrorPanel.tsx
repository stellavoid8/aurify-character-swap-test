import { AlertTriangle } from 'lucide-react';
import { ERRORS, isErrorCode } from '@/lib/errors';
import type { ErrorCode } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from './Button';

type ErrorPanelProps = {
  /** Unknown codes fall back to INTERNAL_ERROR so the user always sees catalogue copy. */
  code: ErrorCode | (string & {});
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

export function ErrorPanel({ code, onRetry, retryLabel = 'Try again', className }: ErrorPanelProps) {
  const { message, nextStep } = ERRORS[isErrorCode(code) ? code : 'INTERNAL_ERROR'];
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-4 px-4 py-10 text-center', className)}>
      <div aria-hidden className="flex size-14 items-center justify-center rounded-pill bg-danger-soft text-danger">
        <AlertTriangle className="size-6" />
      </div>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-heading">{message}</h2>
        <p className="text-body text-ink-muted">{nextStep}</p>
      </div>
      {onRetry && (
        <Button size="lg" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
