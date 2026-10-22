import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { jobRounds, jobs } from '../db/schema';
import { ERRORS } from '../errors';
import type { ErrorCode } from '../types';

/**
 * The single place that writes `jobs.status` / `jobs.stage` after a job is created.
 * Every write is guarded by the round: a round that is no longer the job's current one (a late
 * webhook from an earlier attempt, a superseded Try again) can't move the job.
 */

type Stage = (typeof jobs.stage.enumValues)[number];

/** True while `roundId` is the job's current round and the job is still running. */
const isCurrentRound = (jobId: string, roundId: string) =>
  and(
    eq(jobs.id, jobId),
    eq(jobs.status, 'running'),
    eq(jobs.currentRound, sql`(select ${jobRounds.round} from ${jobRounds} where ${jobRounds.id} = ${roundId})`),
  );

export async function setStage(jobId: string, roundId: string, stage: Stage): Promise<boolean> {
  const rows = await db.update(jobs).set({ stage }).where(isCurrentRound(jobId, roundId)).returning({ id: jobs.id });
  return rows.length > 0;
}

/** Fails the round and, if it is still the current one, the job, with the catalogue copy for `code`. */
export async function failJob(jobId: string, roundId: string, code: ErrorCode): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(jobRounds)
      .set({ status: 'failed', finishedAt: now })
      .where(and(eq(jobRounds.id, roundId), eq(jobRounds.status, 'running')));
    await tx
      .update(jobs)
      .set({ status: 'failed', stage: 'done', errorCode: code, errorMessage: ERRORS[code].message, finishedAt: now })
      .where(isCurrentRound(jobId, roundId));
  });
}
