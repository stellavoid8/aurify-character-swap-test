import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const TONES = {
  neutral: 'bg-surface-2 text-ink-muted',
  accent: 'bg-accent-soft text-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const;

type BadgeProps = ComponentProps<'span'> & { tone?: keyof typeof TONES };

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-caption', TONES[tone], className)}
      {...props}
    />
  );
}
