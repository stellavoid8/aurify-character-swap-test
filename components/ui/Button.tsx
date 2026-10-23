import Link from 'next/link';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

const VARIANTS = {
  primary: 'bg-linear-to-b from-accent-hover to-accent text-accent-ink shadow-glow hover:from-accent-hover hover:to-accent-hover',
  secondary: 'bg-surface/60 text-ink border border-line backdrop-blur-md hover:bg-surface-2',
  ghost: 'bg-transparent text-ink hover:bg-surface-2/70',
} as const;

const SIZES = {
  md: 'h-11 px-5',
  lg: 'h-12 px-6 w-full md:w-auto',
} as const;

type StyleProps = { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES };

export function buttonStyles({ variant = 'primary', size = 'md' }: StyleProps = {}): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-pill text-body font-semibold transition-colors motion-reduce:transition-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
  );
}

type ButtonProps = ComponentProps<'button'> & StyleProps & { loading?: boolean };

export function Button({
  variant,
  size,
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonStyles({ variant, size }), className)}
      {...props}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & StyleProps;

/** A link that looks like a Button, for navigation actions. */
export function ButtonLink({ variant, size, className, ...props }: ButtonLinkProps) {
  return <Link className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}
