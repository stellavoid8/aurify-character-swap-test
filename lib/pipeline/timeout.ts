import 'server-only';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { jobRounds, jobs, type Job } from '../db/schema';
import { ERRORS } from '../errors';

/**
 * The 6-minute limit, applied lazily on read (and by the cleanup cron). The update is conditional
 * on the job still running past its deadline, so concurrent readers time it out exactly once.
 */
export async function enforceTimeout(job: Job): Promise<Job> {
  if (job.status !== 'running' || !job.deadlineAt || job.deadlineAt.getTime() > Date.now()) return job;

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({
        status: 'timed_out',
        stage: 'done',
        errorCode: 'JOB_TIMED_OUT',
        errorMessage: ERRORS.JOB_TIMED_OUT.message,
        finishedAt: sql`now()`,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running'), lt(jobs.deadlineAt, sql`now()`)))
      .returning();
    if (!row) return null;
    await tx
      .update(jobRounds)
      .set({ status: 'timed_out', finishedAt: sql`now()` })
      .where(and(eq(jobRounds.jobId, job.id), eq(jobRounds.round, row.currentRound), eq(jobRounds.status, 'running')));
    return row;
  });
  if (updated) {
    console.info('[timeout] job timed out', { jobId: job.id, stage: job.stage });
    return updated;
  }

  // Another reader timed it out, the job finished, or our clock ran ahead of the database's.
  const [current] = await db.select().from(jobs).where(eq(jobs.id, job.id));
  return current ?? job;
}
