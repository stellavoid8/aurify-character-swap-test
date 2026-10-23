import { Plus, ScanFace } from 'lucide-react';
import Link from 'next/link';
import { ButtonLink } from './Button';

/** `showNewPicture` is off on the gate, where there's nothing to start yet. */
export function AppHeader({ showNewPicture = true }: { showNewPicture?: boolean }) {
  return (
    <header className="sticky top-0 z-20 shrink-0 px-4 pt-3 md:px-8 md:pt-4">
      <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center justify-between gap-4 rounded-pill border border-line bg-surface/60 py-1.5 pr-1.5 pl-4 backdrop-blur-xl">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-pill font-display text-heading focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span aria-hidden className="flex size-8 items-center justify-center rounded-pill bg-linear-to-br from-glow-violet to-glow-indigo text-accent-ink shadow-glow">
            <ScanFace className="size-4.5" />
          </span>
          Character Swap
        </Link>
        {showNewPicture && (
          <ButtonLink href="/" className="h-10 px-4 text-small">
            <Plus aria-hidden className="size-4" />
            <span className="sr-only md:not-sr-only">New picture</span>
          </ButtonLink>
        )}
      </div>
    </header>
  );
}
