import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Text stays in ink for contrast; the icon carries the tone color, so color is never the only signal.
const TONES: Record<NoticeTone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: 'bg-accent-soft', icon: 'text-glow-violet', Icon: Info },
  success: { box: 'bg-success-soft', icon: 'text-success', Icon: CheckCircle2 },
  warning: { box: 'bg-warning-soft', icon: 'text-warning', Icon: AlertTriangle },
  danger: { box: 'bg-danger-soft', icon: 'text-danger', Icon: XCircle },
};

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

type NoticeProps = {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  className?: string;
};

export function Notice({ tone = 'info', title, children, className }: NoticeProps) {
  const { box, icon, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border border-line/60 p-3 text-small text-ink md:p-4', box, className)}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', icon)} />
      <div className="flex flex-col gap-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
