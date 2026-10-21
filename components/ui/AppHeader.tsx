import Link from 'next/link';

export function AppHeader() {
  return (
    <header className="border-b border-line bg-surface px-4 py-3 md:px-8">
      <div className="mx-auto flex min-h-11 w-full max-w-5xl items-center">
        <Link
          href="/"
          className="rounded-sm font-display text-heading focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Character Swap
        </Link>
      </div>
    </header>
  );
}
