import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

type CardProps = ComponentProps<'div'> & { as?: 'div' | 'section' | 'article' | 'figure' };

export function Card({ as: Tag = 'div', className, ...props }: CardProps) {
  return <Tag className={cn('rounded-lg border border-line bg-surface/70 p-4 shadow-card backdrop-blur-md md:p-6', className)} {...props} />;
}
