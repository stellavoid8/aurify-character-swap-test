import 'server-only';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { jobRounds, jobs, type Job } from '../db/schema';
import { ERRORS } from '../errors';
import type { JobNotice } from '../types';

const REFINEMENT_FAILED: JobNotice[] = [{ code: 'REFINEMENT_FAILED' }];

/**
 * The 6-minute limit, applied lazily on read (and by the cleanup cron). The update is conditional
 * on the job still running past its deadline, so concurrent readers time it out exactly once.
 * A Fix the face round that runs out of time is a failed refinement, not a failed job: the job
 * goes back to `succeeded` with its original picture and the REFINEMENT_FAILED notice.
 */
export async function enforceTimeout(job: Job): Promise<Job> {
  if (job.status !== 'running' || !job.deadlineAt || job.deadlineAt.getTime() > Date.now()) return job;

  const refining = job.stage === 'refining';
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set(
        refining
          ? { status: 'succeeded', stage: 'done', notices: sql`${jobs.notices} || ${JSON.stringify(REFINEMENT_FAILED)}::jsonb`, finishedAt: sql`now()` }
          : {
              status: 'timed_out',
              stage: 'done',
              errorCode: 'JOB_TIMED_OUT',
              errorMessage: ERRORS.JOB_TIMED_OUT.message,
              finishedAt: sql`now()`,
            },
      )
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, 'running'),
          refining ? eq(jobs.stage, 'refining') : ne(jobs.stage, 'refining'),
          lt(jobs.deadlineAt, sql`now()`),
        ),
      )
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
