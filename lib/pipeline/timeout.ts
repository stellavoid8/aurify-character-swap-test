import 'server-only';
import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { jobRounds, jobs, type Job } from '../db/schema';
import { ERRORS } from '../errors';
import type { JobNotice } from '../types';

/** Stages whose round only adds to a finished picture: running out of time there keeps the job succeeded. */
const SOFT_STAGES = ['refining', 'animating'] as const satisfies Job['stage'][];
const SOFT_NOTICE: Record<(typeof SOFT_STAGES)[number], JobNotice[]> = {
  refining: [{ code: 'REFINEMENT_FAILED' }],
  animating: [{ code: 'ANIMATION_FAILED' }],
};

/**
 * The round's deadline (6 minutes, or ANIMATION_TIMEOUT_MS for a video), applied lazily on read
 * (and by the cleanup cron). The update is conditional on the job still running past its deadline,
 * so concurrent readers time it out exactly once. A Fix the face or animation round that runs out
 * of time is a failed refinement or animation, not a failed job: the job goes back to `succeeded`
 * with the picture it had and the REFINEMENT_FAILED or ANIMATION_FAILED notice.
 */
export async function enforceTimeout(job: Job): Promise<Job> {
  if (job.status !== 'running' || !job.deadlineAt || job.deadlineAt.getTime() > Date.now()) return job;

  const softStage = (SOFT_STAGES as readonly string[]).includes(job.stage) ? (job.stage as (typeof SOFT_STAGES)[number]) : null;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set(
        softStage
          ? { status: 'succeeded', stage: 'done', notices: sql`${jobs.notices} || ${JSON.stringify(SOFT_NOTICE[softStage])}::jsonb`, finishedAt: sql`now()` }
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
          softStage ? eq(jobs.stage, softStage) : notInArray(jobs.stage, SOFT_STAGES),
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
