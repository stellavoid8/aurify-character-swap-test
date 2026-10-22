import 'server-only';
import { revalidateTag } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../db';
import { jobRounds, jobs } from '../db/schema';
import { ERRORS } from '../errors';
import { markStageEnd } from '../telemetry';
import type { ErrorCode } from '../types';
import { rankRound } from './rank';

/** Cache tag of `getEtaMs` (server/stats/queries.ts): a finished round is a new ETA sample. */
const ETA_TAG = 'eta';

/**
 * The single place that writes `jobs.status` / `jobs.stage` after a job is created, apart from
 * the deadline in timeout.ts.
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
 * `ranking`: ranks the results and finishes the round with the best one.
 */
export async function onRoundGenerated(roundId: string): Promise<void> {
  const [round] = await db.select().from(jobRounds).where(eq(jobRounds.id, roundId));
  if (!round) return;
  const chosen = await rankRound(roundId);
  if (!chosen) {
    await failJob(round.jobId, roundId, 'GENERATION_FAILED');
    return;
  }
  await finishRound(round.jobId, roundId, chosen);
}

/** Succeeds the round and, if it is still the current one, the job, with `chosenCandidateId` as its picture. */
export async function finishRound(jobId: string, roundId: string, chosenCandidateId: string): Promise<void> {
  await markStageEnd(roundId, 'ranking');
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(jobRounds)
      .set({ status: 'succeeded', finishedAt: now })
      .where(and(eq(jobRounds.id, roundId), eq(jobRounds.status, 'running')));
    await tx
      .update(jobs)
      .set({ status: 'succeeded', stage: 'done', chosenCandidateId, finishedAt: now })
      .where(isCurrentRound(jobId, roundId));
  });
  try {
    revalidateTag(ETA_TAG);
  } catch (err) {
    // Only possible outside a Next request scope (scripts); the ETA cache then expires on its own.
    console.warn('[orchestrator] eta revalidation skipped', err instanceof Error ? err.message : err);
  }
}
