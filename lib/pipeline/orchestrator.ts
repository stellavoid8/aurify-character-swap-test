import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../db';
import { candidates, jobRounds, jobs } from '../db/schema';
import { ERRORS } from '../errors';
import { markStageEnd } from '../telemetry';
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

/**
 * Fails the round and, if it is still the current one, the job, with the catalogue copy for `code`.
 * Pass the caller's transaction when it already holds the job row lock (the fan-in does).
 */
export async function failJob(jobId: string, roundId: string, code: ErrorCode, executor: Executor = db): Promise<void> {
  const now = new Date();
  await executor.transaction(async (tx) => {
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

/**
 * Called once per round, by the fan-in, after every candidate finished and the job moved to
 * `ranking`. TODO(prompt 13): replace this stub with rankRound(roundId). For now it picks the
 * earliest succeeded candidate and finishes the round and the job.
 */
export async function onRoundGenerated(roundId: string): Promise<void> {
  const [round] = await db.select().from(jobRounds).where(eq(jobRounds.id, roundId));
  if (!round) return;
  const [first] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.roundId, roundId), eq(candidates.status, 'succeeded')))
    .orderBy(asc(candidates.completedAt))
    .limit(1);
  if (!first) {
    await failJob(round.jobId, roundId, 'GENERATION_FAILED');
    return;
  }

  await markStageEnd(roundId, 'ranking');
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(candidates).set({ rank: 1 }).where(eq(candidates.id, first.id));
    await tx
      .update(jobRounds)
      .set({ status: 'succeeded', finishedAt: now })
      .where(and(eq(jobRounds.id, roundId), eq(jobRounds.status, 'running')));
    await tx
      .update(jobs)
      .set({ status: 'succeeded', stage: 'done', chosenCandidateId: first.id, finishedAt: now })
      .where(isCurrentRound(round.jobId, roundId));
  });
}
