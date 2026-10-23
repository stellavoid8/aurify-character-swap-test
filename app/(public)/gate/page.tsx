import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { GateForm } from '@/components/gate/GateForm';
import { AppHeader } from '@/components/ui/AppHeader';
import { Card } from '@/components/ui/Card';
import { env } from '@/lib/env';
import { getSession, safeNextPath } from '@/lib/session';

export const metadata: Metadata = { title: 'Enter access code · Character Swap' };

type GatePageProps = { searchParams: Promise<{ next?: string | string[] }> };

export default async function GatePage({ searchParams }: GatePageProps) {
  const { next: rawNext } = await searchParams;
  const next = safeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);
  if (await getSession()) redirect(next);

  return (
    <>
      <AppHeader showNewPicture={false} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-8 px-4 py-8 md:px-8">
        <div className="flex max-w-2xl flex-col items-center gap-4 text-center">
          <p className="flex items-center gap-2 text-small text-ink-muted">
            <span aria-hidden className="size-1.5 rounded-pill bg-ink" />
            Private access
          </p>
          <h1 className="font-display text-display md:text-hero">
            Step into any <span className="bg-linear-to-r from-glow-violet to-glow-blue bg-clip-text text-transparent">photo</span>
          </h1>
          <p className="max-w-md text-body text-ink-muted">Put yourself into any photo. Enter the access code you were given.</p>
        </div>
        <Card className="w-full max-w-sm">
          <GateForm next={next} />
        </Card>
        <p className="max-w-sm text-center text-caption text-ink-muted">
          Your photos are used only to make your pictures and are deleted after {env.RETENTION_DAYS} days.
        </p>
      </main>
    </>
  );
}
