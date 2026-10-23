import { Glasses, Images, ScanFace, Sun, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MAX_USER_PHOTOS } from '@/lib/limits';

type Tip = { Icon: LucideIcon; text: string; struck?: boolean };

const TIPS: Tip[] = [
  { Icon: ScanFace, text: 'Face the camera' },
  { Icon: Sun, text: 'Good, even light' },
  { Icon: Glasses, text: 'No sunglasses or hat', struck: true },
  { Icon: Images, text: `1 to ${MAX_USER_PHOTOS} photos, just you` },
];

/** What makes a good photo of yourself. `highlight` draws attention to it when no photo can be used. */
export function PhotoGuidance({ highlight = false }: { highlight?: boolean }) {
  return (
    <ul
      aria-label="Tips for good photos"
      className={cn(
        'grid grid-cols-2 gap-3 rounded-md p-3 text-small md:flex md:flex-wrap md:gap-6',
        highlight ? 'bg-warning-soft' : 'border border-line bg-surface/50 backdrop-blur-md',
      )}
    >
      {TIPS.map(({ Icon, text, struck }) => (
        <li key={text} className="flex items-center gap-2">
          <span aria-hidden className="relative flex shrink-0 text-ink-muted">
            <Icon className="size-5" />
            {struck && <span className="absolute top-1/2 left-1/2 h-0.5 w-6 -translate-1/2 -rotate-45 rounded-pill bg-current" />}
          </span>
          {text}
        </li>
      ))}
    </ul>
  );
}
