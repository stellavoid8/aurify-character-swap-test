import { notFound, redirect } from 'next/navigation';
import { JobScreen } from '@/components/job/JobScreen';
import { AppError } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { getJobView } from '@/server/jobs/view';

export const runtime = 'nodejs';
// Try again and Fix the face are Server Actions on this page; their after() work (analysis on a
// retry of a job whose analysis failed, fal submissions) runs under this page's limit.
export const maxDuration = 60;

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession().catch(() => null);
  if (!session) redirect('/gate');
  const { id } = await params;

  const view = await getJobView(session.sid, id).catch((err: unknown) => {
    if (err instanceof AppError && err.code === 'JOB_NOT_FOUND') notFound();
    throw err;
  });

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <JobScreen initial={view} />
    </main>
  );
}
