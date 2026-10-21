import { CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ProgressStep = { label: string; state: 'done' | 'active' | 'todo' };

const STATE_TEXT = { done: 'done', active: 'in progress', todo: 'not started' } as const;

export function ProgressSteps({ steps, className }: { steps: ProgressStep[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col gap-3', className)}>
      {steps.map((step) => (
        <li
          key={step.label}
          aria-current={step.state === 'active' ? 'step' : undefined}
          className={cn(
            'flex items-center gap-3 text-body',
            step.state === 'todo' ? 'text-ink-muted' : 'text-ink',
            step.state === 'active' && 'font-semibold',
          )}
        >
          {step.state === 'done' && <CheckCircle2 aria-hidden className="size-5 shrink-0 text-success" />}
          {step.state === 'active' && <Spinner className="text-accent" />}
          {step.state === 'todo' && <Circle aria-hidden className="size-5 shrink-0" />}
          <span>
            {step.label}
            <span className="sr-only">, {STATE_TEXT[step.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
