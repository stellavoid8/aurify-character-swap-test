import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

const STEPS = ['Template', 'Your photos', 'Result'] as const;

const CIRCLE = {
  done: 'bg-success-soft text-success',
  current: 'bg-accent text-accent-ink',
  upcoming: 'bg-surface-2 text-ink-muted',
} as const;

export function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Progress">
      <ol className="flex items-center gap-2 md:gap-3">
        {STEPS.map((label, index) => {
          const step = index + 1;
          const state = step < current ? 'done' : step === current ? 'current' : 'upcoming';
          return (
            <li
              key={label}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex items-center gap-2 md:gap-3"
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-pill text-caption',
                  CIRCLE[state],
                )}
              >
                {state === 'done' ? <Check className="size-4" /> : step}
              </span>
              {/* Mobile shows only the current label; the others stay readable by screen readers. */}
              <span
                className={cn(
                  'text-small',
                  state === 'current' ? 'font-semibold text-ink' : 'sr-only text-ink-muted md:not-sr-only',
                )}
              >
                <span className="sr-only">Step {step}: </span>
                {label}
                {state === 'done' && <span className="sr-only"> (done)</span>}
              </span>
              {step < STEPS.length && <span aria-hidden className="h-px w-4 bg-line md:w-8" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
