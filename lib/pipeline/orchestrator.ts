import 'server-only';
import { revalidateTag } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../db';
import { candidates, jobRounds, jobs, type Job } from '../db/schema';
import { AppError, ERRORS } from '../errors';
import { ANIMATION_TIMEOUT_MS } from '../limits';
import { markStageEnd } from '../telemetry';
import type { ErrorCode, JobNotice } from '../types';
import { rankRound } from './rank';

/** Cache tag of `getEtaMs` and `getAnimationMsPerSecond` (server/stats/queries.ts). */
const ETA_TAG = 'eta';

/** A finished round is a new ETA sample. */
function revalidateEta(): void {
  try {
    revalidateTag(ETA_TAG);
  } catch (err) {
    // Only possible outside a Next request scope (scripts); the ETA cache then expires on its own.
    console.warn('[orchestrator] eta revalidation skipped', err instanceof Error ? err.message : err);
  }
}

/** Appended on a failed refinement; every new round clears it again (see `reopenJob`). */
const REFINEMENT_FAILED: JobNotice[] = [{ code: 'REFINEMENT_FAILED' }];
/** Appended when a video job's animation fails, times out or can't start; the stills stand. */
const ANIMATION_FAILED: JobNotice[] = [{ code: 'ANIMATION_FAILED' }];

/**
 * The single place that writes `jobs.status` / `jobs.stage` while a round runs, apart from the
 * deadline in timeout.ts. Opening a round (createJob, Try again, Fix the face, Animate this one) is
 * server/jobs/create.ts, except a video job's animation round, which finishRound chains itself.
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

/**
 * Succeeds the round and, if it is still the current one, the job, with `chosenCandidateId` as its
 * picture. A video job doesn't stop there: in the same transaction its best still opens the
 * animation round, which is then submitted.
 */
export async function finishRound(jobId: string, roundId: string, chosenCandidateId: string): Promise<void> {
  await markStageEnd(roundId, 'ranking');
  const now = new Date();
  const animation = await db.transaction(async (tx) => {
    await tx
      .update(jobRounds)
      .set({ status: 'succeeded', finishedAt: now })
      .where(and(eq(jobRounds.id, roundId), eq(jobRounds.status, 'running')));
    const [job] = await tx
      .update(jobs)
      .set({ status: 'succeeded', stage: 'done', chosenCandidateId, finishedAt: now })
      .where(isCurrentRound(jobId, roundId))
      .returning();
    return job?.mode === 'video' ? chainAnimation(tx, job, chosenCandidateId) : null;
  });
  revalidateEta();
  if (animation) {
    const { runAnimationRound } = await import('./animate');
    await runAnimationRound({ jobId, ...animation });
  }
}

/**
 * Puts a video job whose stills just succeeded back to `running` in an animation round of its best
 * still. Runs in a savepoint: when there aren't enough units left for the video, the job stays
 * succeeded with its stills and the ANIMATION_FAILED notice.
 */
async function chainAnimation(tx: Executor, job: Job, parentId: string) {
  // Loaded here, not at the top: animate.ts imports this module, and photo jobs never need it.
  const { openAnimationRound } = await import('./animate');
  const [parent] = await tx.select().from(candidates).where(eq(candidates.id, parentId));
  try {
    return await tx.transaction(async (sp) => {
      await sp
        .update(jobs)
        .set({
          status: 'running',
          stage: 'animating',
          deadlineAt: sql`now() + make_interval(secs => ${ANIMATION_TIMEOUT_MS / 1000})`,
          finishedAt: null,
        })
        .where(eq(jobs.id, job.id));
      return openAnimationRound(sp, { jobId: job.id, sid: job.sessionId, parent });
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    console.info('[orchestrator] animation not started', { jobId: job.id, code: err.code });
    await tx
      .update(jobs)
      .set({ notices: sql`${jobs.notices} || ${JSON.stringify(ANIMATION_FAILED)}::jsonb` })
      .where(eq(jobs.id, job.id));
    return null;
  }
}

/**
 * Ends a Fix the face round. Either way the job goes back to `succeeded`, because the picture it
 * was refining is still valid: a failure only adds the REFINEMENT_FAILED notice. The chosen
 * version never changes here; the user decides between before and after.
 */
export async function finishRefinement(jobId: string, roundId: string, outcome: 'succeeded' | 'failed'): Promise<void> {
  await markStageEnd(roundId, 'refining');
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(jobRounds)
      .set({ status: outcome, finishedAt: now })
      .where(and(eq(jobRounds.id, roundId), eq(jobRounds.status, 'running')));
    await tx
      .update(jobs)
      .set({
        status: 'succeeded',
        stage: 'done',
        finishedAt: now,
        ...(outcome === 'failed' ? { notices: sql`${jobs.notices} || ${JSON.stringify(REFINEMENT_FAILED)}::jsonb` } : {}),
      })
      .where(isCurrentRound(jobId, roundId));
  });
}

/**
 * Ends an animation round. Either way the job goes back to `succeeded`: on success the video becomes
 * the chosen version; on failure the stills stand with the ANIMATION_FAILED notice.
 */
export async function finishAnimation(
  jobId: string,
  roundId: string,
  outcome: 'succeeded' | 'failed',
  candidateId?: string,
): Promise<void> {
  await markStageEnd(roundId, 'animating');
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(jobRounds)
      .set({ status: outcome, finishedAt: now })
      .where(and(eq(jobRounds.id, roundId), eq(jobRounds.status, 'running')));
    await tx
      .update(jobs)
      .set({
        status: 'succeeded',
        stage: 'done',
        finishedAt: now,
        ...(outcome === 'succeeded' && candidateId
          ? { chosenCandidateId: candidateId }
          : { notices: sql`${jobs.notices} || ${JSON.stringify(ANIMATION_FAILED)}::jsonb` }),
      })
      .where(isCurrentRound(jobId, roundId));
  });
  if (outcome === 'succeeded') revalidateEta();
}
