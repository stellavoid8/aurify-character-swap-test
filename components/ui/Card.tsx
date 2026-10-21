import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

type CardProps = ComponentProps<'div'> & { as?: 'div' | 'section' | 'article' };

export function Card({ as: Tag = 'div', className, ...props }: CardProps) {
  return <Tag className={cn('rounded-lg bg-surface p-4 shadow-card md:p-6', className)} {...props} />;
}
