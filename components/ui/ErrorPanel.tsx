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
  /** Shows the retry button disabled (an action that isn't available yet). */
  retryDisabled?: boolean;
  /** Shows a spinner on the retry button while its action runs. */
  retryLoading?: boolean;
  className?: string;
};

export function ErrorPanel({
  code,
  onRetry,
  retryLabel = 'Try again',
  retryDisabled = false,
  retryLoading = false,
  className,
}: ErrorPanelProps) {
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
      {(onRetry || retryDisabled) && (
        <Button size="lg" onClick={onRetry} disabled={retryDisabled} loading={retryLoading}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
