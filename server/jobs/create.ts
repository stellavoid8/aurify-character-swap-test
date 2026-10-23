import 'server-only';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '@/lib/db';
import { candidates, jobs, type Job } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { REFINE_MODEL } from '@/lib/fal/models';
import { ANIMATION_ROUND_UNITS, ANIMATION_TIMEOUT_MS, JOB_TIMEOUT_MS, MAX_ROUNDS_PER_JOB, MAX_USER_PHOTOS } from '@/lib/limits';
import { openAnimationRound } from '@/lib/pipeline/animate';
import { startRound } from '@/lib/pipeline/rounds';
import { checkUnits } from '@/lib/rate-limit';
import { getUploadsForSession } from '@/server/uploads/queries';
import { getCandidateForSession, getJobForSession } from './queries';

export const createJobSchema = z.object({
  templateUploadId: z.uuid(),
  userUploadIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_USER_PHOTOS)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'duplicate photo' }),
});
export type CreateJobInput = z.input<typeof createJobSchema>;

/**
 * Validates the photos and opens round 1. Fast by design (no provider calls): the caller schedules
 * `runGenerationRound` in after() with the returned ids. A clip template makes a video job, which
 * needs the units for its stills and its animation round up front.
 */
export async function createJob(sid: string, input: unknown): Promise<{ jobId: string; roundId: string }> {
  const { templateUploadId, userUploadIds } = createJobSchema.parse(input);
  if (userUploadIds.includes(templateUploadId)) throw new AppError('VALIDATION_FAILED', { detail: 'template listed as a user photo' });

  const [template, ...photos] = await getUploadsForSession(sid, [templateUploadId, ...userUploadIds]);
  if (template.kind !== 'template' || template.status !== 'ok' || !template.url) {
    throw new AppError('VALIDATION_FAILED', { detail: 'template upload not usable' });
  }
  if (photos.some((p) => p.kind !== 'user' || p.status !== 'ok' || !p.url)) {
    throw new AppError('VALIDATION_FAILED', { detail: 'user photo not usable' });
  }
  const mode = template.mediaType === 'video' ? 'video' : 'photo';
  if (mode === 'video' && !env.VIDEO_ENABLED) throw new AppError('VIDEO_UNAVAILABLE');
  if (mode === 'video' && !template.videoUrl) throw new AppError('VALIDATION_FAILED', { detail: 'clip template has no video' });

  return db.transaction(async (tx) => {
    if (mode === 'video') await checkUnits(sid, tx, 1 + ANIMATION_ROUND_UNITS);
    const [job] = await tx
      .insert(jobs)
      .values({
        sessionId: sid,
        mode,
        status: 'running',
        stage: 'analyzing',
        templateUploadId,
        userUploadIds,
        deadlineAt: sql`now() + make_interval(secs => ${JOB_TIMEOUT_MS / 1000})`,
      })
      .returning({ id: jobs.id });
    const { roundId } = await startRound(tx, { jobId: job.id, sid, kind: 'generation' });
    return { jobId: job.id, roundId };
  });
}

const FINISHED = ['succeeded', 'failed', 'timed_out'] as const satisfies Job['status'][];
const isFinished = (job: Job) => (FINISHED as readonly string[]).includes(job.status);

/** The notice of a failed Fix the face or animation describes that round only; the next round drops it. */
const withoutRoundNotices = sql`coalesce(
  (select jsonb_agg(n) from jsonb_array_elements(${jobs.notices}) n
    where n ->> 'code' not in ('REFINEMENT_FAILED', 'ANIMATION_FAILED')),
  '[]'::jsonb)`;

/**
 * Puts a finished job back to `running` for its next round, with a fresh deadline (`timeoutMs`), inside the
 * caller's transaction. Conditional on the job still being finished and under MAX_ROUNDS_PER_JOB,
 * so of two concurrent Try again / Fix the face requests only one opens a round.
 */
async function reopenJob(tx: Executor, job: Job, stage: Job['stage'], timeoutMs = JOB_TIMEOUT_MS): Promise<void> {
  const rows = await tx
    .update(jobs)
    .set({
      status: 'running',
      stage,
      deadlineAt: sql`now() + make_interval(secs => ${timeoutMs / 1000})`,
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      notices: withoutRoundNotices,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.sessionId, job.sessionId),
        inArray(jobs.status, FINISHED),
        lt(jobs.currentRound, MAX_ROUNDS_PER_JOB),
      ),
    )
    .returning({ id: jobs.id });
  if (rows.length === 0) throw new AppError('INVALID_STATE', { detail: 'job started another round meanwhile' });
}

/** The checks Try again and Fix the face share: the job is finished and has rounds left. */
function assertReopenable(job: Job): void {
  if (!isFinished(job)) throw new AppError('INVALID_STATE', { detail: `job is ${job.status}` });
  if (job.currentRound >= MAX_ROUNDS_PER_JOB) throw new AppError('RATE_LIMITED_SESSION', { detail: 'MAX_ROUNDS_PER_JOB reached' });
}

/**
 * Try again: opens a generation round of new versions, one per generator. Earlier candidates
 * stay. The caller schedules `runGenerationRound`, which skips analysis when the job already has one.
 */
export async function startRetry(sid: string, jobId: string): Promise<{ roundId: string; round: number }> {
  const job = await getJobForSession(sid, jobId);
  assertReopenable(job);
  return db.transaction(async (tx) => {
    await reopenJob(tx, job, job.analysis == null ? 'analyzing' : 'generating');
    return startRound(tx, { jobId: job.id, sid, kind: 'generation' });
  });
}

/**
 * Fix the face: opens a refinement round with one pending face-swap candidate of `candidateId`.
 * The caller schedules `runRefinementRound`.
 */
export async function startRefinement(
  sid: string,
  { jobId, candidateId }: { jobId: string; candidateId: string },
): Promise<{ roundId: string; round: number; candidateId: string }> {
  const job = await getJobForSession(sid, jobId);
  const parent = await getCandidateForSession(sid, candidateId);
  if (parent.jobId !== job.id) throw new AppError('JOB_NOT_FOUND', { detail: 'candidate of another job' });
  if (parent.status !== 'succeeded' || !parent.imageUrl) throw new AppError('INVALID_STATE', { detail: 'candidate not succeeded' });
  if (parent.kind === 'animation') throw new AppError('INVALID_STATE', { detail: 'Fix the face works on stills only' });
  assertReopenable(job);

  return db.transaction(async (tx) => {
    await reopenJob(tx, job, 'refining');
    const { roundId, round } = await startRound(tx, { jobId: job.id, sid, kind: 'refinement' });
    const [candidate] = await tx
      .insert(candidates)
      .values({
        jobId: job.id,
        roundId,
        kind: 'refinement',
        parentCandidateId: parent.id,
        model: REFINE_MODEL,
        // Face swap has no seed; the column is required.
        seed: 0,
        attempt: 1,
        status: 'pending',
      })
      .returning({ id: candidates.id });
    return { roundId, round, candidateId: candidate.id };
  });
}

/**
 * Animate this one: opens an animation round of a finished still of a video job. The caller
 * schedules `runAnimationRound`.
 */
export async function startAnimation(
  sid: string,
  { jobId, candidateId }: { jobId: string; candidateId: string },
): Promise<{ roundId: string; round: number; candidateId: string }> {
  const job = await getJobForSession(sid, jobId);
  const parent = await getCandidateForSession(sid, candidateId);
  if (parent.jobId !== job.id) throw new AppError('JOB_NOT_FOUND', { detail: 'candidate of another job' });
  if (job.mode !== 'video') throw new AppError('INVALID_STATE', { detail: 'not a video job' });
  if (!env.VIDEO_ENABLED) throw new AppError('VIDEO_UNAVAILABLE');
  if (parent.status !== 'succeeded' || !parent.imageUrl) throw new AppError('INVALID_STATE', { detail: 'candidate not succeeded' });
  if (parent.kind === 'animation') throw new AppError('INVALID_STATE', { detail: 'animate a still, not a video' });
  assertReopenable(job);

  return db.transaction(async (tx) => {
    await reopenJob(tx, job, 'animating', ANIMATION_TIMEOUT_MS);
    return openAnimationRound(tx, { jobId: job.id, sid, parent });
  });
}
