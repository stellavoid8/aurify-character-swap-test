import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { GateForm } from '@/components/gate/GateForm';
import { env } from '@/lib/env';
import { getSession, safeNextPath } from '@/lib/session';

export const metadata: Metadata = { title: 'Enter access code · Character Swap' };

type GatePageProps = { searchParams: Promise<{ next?: string | string[] }> };

export default async function GatePage({ searchParams }: GatePageProps) {
  const { next: rawNext } = await searchParams;
  const next = safeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);
  if (await getSession()) redirect(next);

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-4 pt-16">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-display">Character Swap</h1>
        <p className="text-body text-ink-muted">Put yourself into any photo. Enter the access code you were given.</p>
      </div>
      <GateForm next={next} />
      <p className="text-caption text-ink-muted">
        Your photos are used only to make your pictures and are deleted after {env.RETENTION_DAYS} days.
      </p>
    </main>
  );
}
