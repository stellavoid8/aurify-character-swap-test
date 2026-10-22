import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

const SIZES = { sm: 'size-4', md: 'size-5', lg: 'size-8' } as const;

type SpinnerProps = {
  size?: keyof typeof SIZES;
  /** When set, the spinner announces itself to screen readers; otherwise it is decorative. */
  label?: string;
  className?: string;
};

export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  const icon = <LoaderCircle aria-hidden className={cn('shrink-0 animate-spin motion-reduce:animate-none', SIZES[size], className)} />;
  if (!label) return icon;
  return (
    <span role="status" className="inline-flex">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
