import 'server-only';
import { randomInt } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { z } from 'zod';
import { db } from '../db';
import { candidates, jobRounds, jobs, uploads, webhookEvents, type Candidate } from '../db/schema';
import { isContentPolicyError } from '../fal/client';
import { parseOutput, parseVideoOutput, type FalModel } from '../fal/models';
import { falCostMicros, falVideoCostMicros } from '../fal/pricing';
import { ANIMATION_RESOLUTION, MAX_AUTO_RETRIES, MAX_RESULT_VIDEO_BYTES } from '../limits';
import { fetchObject, putObject } from '../storage';
import { markStageEnd, markStageStart, recordCall } from '../telemetry';
import type { ErrorCode, JobNotice } from '../types';
import { settleAnimation, submitAnimation } from './animate';
import { generationInputFor, submitCandidate } from './generate';
import { failJob, onRoundGenerated } from './orchestrator';
import { settleRefinement, submitRefinement } from './refine';

/**
 * Receives fal's completion callbacks (after the route has verified the token and deduplicated the
 * event): copies results into our storage, retries a provider error once with a new seed, and fans
 * the round's candidates in so that exactly one callback moves the job on. A refinement or animation
 * candidate is its round's only one, so its events go to `settleRefinement` / `settleAnimation`
 * instead of ranking.
 *
 * Every candidate write is conditional on `(id, attempt, status = 'pending')`, so a stale or
 * repeated callback can never overwrite a finished candidate or a newer attempt.
 */

/** The JSON body fal POSTs to a webhook URL. */
export const FalWebhookBody = z.object({
  request_id: z.string().min(1),
  status: z.enum(['OK', 'ERROR']),
  payload: z.unknown().optional(),
  error: z.string().nullish(),
});
export type FalWebhookBody = z.infer<typeof FalWebhookBody>;

/** Same range as the first-attempt seeds in generate.ts (Postgres `int`). */
const SEED_MAX = 2 ** 31 - 1;

const LATE_NOTICE: JobNotice = { code: 'LATE_RESULTS_ADDED' };

/** The provider_calls stage of a candidate's fal request. */
const STAGE_OF_KIND = { generation: 'generating', refinement: 'refining', animation: 'animating' } as const;
const stageOf = (candidate: Candidate) => STAGE_OF_KIND[candidate.kind];

export async function handleFalWebhook({ cid, attempt, body }: { cid: string; attempt: number; body: FalWebhookBody }): Promise<void> {
  let candidate: Candidate | null;
  try {
    candidate = await applyEvent(cid, attempt, body);
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(webhookEvents.provider, 'fal'), eq(webhookEvents.requestId, body.request_id), eq(webhookEvents.status, body.status)));
  } catch (err) {
    // processed_at stays null, which marks the event for investigation. The job's deadline still ends it.
    console.error('[fan-in] webhook handling failed', { cid, attempt, err });
    return;
  }
  if (!candidate) return;
  const { roundId } = candidate;
  if (candidate.kind === 'refinement') {
    await settleRefinement(candidate.id).catch((err) => console.error('[fan-in] refinement fan-in failed', { roundId, err }));
    return;
  }
  if (candidate.kind === 'animation') {
    await settleAnimation(candidate.id).catch((err) => console.error('[fan-in] animation fan-in failed', { roundId, err }));
    return;
  }
  await maybeFinishRound(roundId).catch((err) => console.error('[fan-in] round fan-in failed', { roundId, err }));
}

/** Applies one callback to its candidate. Returns the candidate (as read before the event), or null when the event was stale. */
async function applyEvent(cid: string, attempt: number, body: FalWebhookBody): Promise<Candidate | null> {
  const [candidate] = await db.select().from(candidates).where(eq(candidates.id, cid));
  // A null request id means the webhook beat submitCandidate's write; the token already pins the attempt.
  const stale =
    !candidate ||
    candidate.attempt !== attempt ||
    candidate.status !== 'pending' ||
    (candidate.falRequestId !== null && candidate.falRequestId !== body.request_id);
  if (stale) {
    console.info('[fan-in] stale webhook ignored', { cid, attempt, current: candidate?.attempt, status: candidate?.status });
    return null;
  }

  if (body.status === 'OK') {
    const stored = candidate.kind === 'animation' ? await storeVideoResult(candidate, body.payload) : await storeResult(candidate, body.payload);
    if (stored.ok) {
      await completeCandidate(candidate, body.request_id, stored.url);
      return candidate;
    }
    await failAttempt(candidate, body.request_id, stored.reason);
    return candidate;
  }

  await failAttempt(candidate, body.request_id, body.error ?? 'provider error', body.payload);
  return candidate;
}

/** Copies fal's first output image into our storage as a JPEG. Never throws. */
async function storeResult(candidate: Candidate, payload: unknown): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const [source] = parseOutput(payload).imageUrls;
  if (!source) return { ok: false, reason: 'no image in payload' };
  try {
    const bytes = await fetchObject(source);
    const jpeg = await sharp(bytes, { failOn: 'error' }).rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    const { url } = await putObject(`results/${candidate.jobId}/${candidate.id}.jpg`, jpeg, 'image/jpeg');
    return { ok: true, url };
  } catch (err) {
    console.error('[fan-in] result copy failed', { candidateId: candidate.id, err: err instanceof Error ? err.message : err });
    return { ok: false, reason: 'result copy failed' };
  }
}

/** Copies fal's output video into our storage as-is. Never throws. */
async function storeVideoResult(candidate: Candidate, payload: unknown): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const { videoUrl } = parseVideoOutput(payload);
  if (!videoUrl) return { ok: false, reason: 'no video in payload' };
  try {
    const bytes = await fetchObject(videoUrl, { maxBytes: MAX_RESULT_VIDEO_BYTES });
    const { url } = await putObject(`results/${candidate.jobId}/${candidate.id}.mp4`, bytes, 'video/mp4');
    return { ok: true, url };
  } catch (err) {
    console.error('[fan-in] video copy failed', { candidateId: candidate.id, err: err instanceof Error ? err.message : err });
    return { ok: false, reason: 'result copy failed' };
  }
}

/** What one successful attempt cost: per image, or for a video per 16 frames of the template clip. */
async function costOf(candidate: Candidate): Promise<number> {
  if (candidate.kind !== 'animation') return falCostMicros(candidate.model as FalModel, 1);
  const [row] = await db
    .select({ frames: uploads.frameCount })
    .from(jobs)
    .innerJoin(uploads, eq(uploads.id, jobs.templateUploadId))
    .where(eq(jobs.id, candidate.jobId));
  return falVideoCostMicros(row?.frames ?? 0, ANIMATION_RESOLUTION);
}

/**
 * Marks the attempt succeeded with our copy of the result (the image, or for an animation the
 * video). A finished job keeps its status but gets a notice.
 */
export async function completeCandidate(candidate: Candidate, requestId: string, resultUrl: string): Promise<boolean> {
  const model = candidate.model;
  const latencyMs = Date.now() - candidate.submittedAt.getTime();
  const costUsdMicros = await costOf(candidate);
  const result = candidate.kind === 'animation' ? { videoUrl: resultUrl } : { imageUrl: resultUrl };
  const done = await db
    .update(candidates)
    .set({ status: 'succeeded', ...result, falRequestId: requestId, latencyMs, costUsdMicros, completedAt: new Date() })
    .where(pendingAttempt(candidate))
    .returning({ id: candidates.id });
  if (done.length === 0) return false;

  await recordCall({
    jobId: candidate.jobId,
    roundId: candidate.roundId,
    candidateId: candidate.id,
    provider: 'fal',
    model,
    stage: stageOf(candidate),
    requestId,
    status: 'ok',
    latencyMs,
    costUsdMicros,
    meta: { attempt: candidate.attempt },
  });

  await db
    .update(jobs)
    .set({ notices: sql`${jobs.notices} || ${JSON.stringify([LATE_NOTICE])}::jsonb` })
    .where(
      and(
        eq(jobs.id, candidate.jobId),
        inArray(jobs.status, ['timed_out', 'failed']),
        sql`not ${jobs.notices} @> ${JSON.stringify([LATE_NOTICE])}::jsonb`,
      ),
    );
  return true;
}

/**
 * A failed attempt: content refusals are final; anything else is resubmitted with a new seed while
 * `attempt <= MAX_AUTO_RETRIES`, then the candidate fails with GENERATION_FAILED (REFINEMENT_FAILED
 * for a refinement, ANIMATION_FAILED for an animation).
 */
async function failAttempt(candidate: Candidate, requestId: string, reason: string, payload?: unknown): Promise<void> {
  const text = `${reason} ${JSON.stringify(payload ?? '')}`;
  const blocked = isContentPolicyError(text);
  await recordCall({
    jobId: candidate.jobId,
    roundId: candidate.roundId,
    candidateId: candidate.id,
    provider: 'fal',
    model: candidate.model,
    stage: stageOf(candidate),
    requestId,
    status: 'error',
    latencyMs: Date.now() - candidate.submittedAt.getTime(),
    costUsdMicros: 0,
    meta: { attempt: candidate.attempt, blocked, reason: reason.slice(0, 200) },
  });

  if (blocked) return failCandidate(candidate, 'CONTENT_BLOCKED');
  const refinement = candidate.kind === 'refinement';
  if (candidate.attempt > MAX_AUTO_RETRIES) return failCandidate(candidate, FINAL_FAILURE[candidate.kind]);

  const [next] = await db
    .update(candidates)
    .set({ attempt: sql`${candidates.attempt} + 1`, seed: randomInt(0, SEED_MAX), falRequestId: null, submittedAt: new Date() })
    .where(pendingAttempt(candidate))
    .returning();
  if (!next) return;
  // Face swap takes no seed: its retry resubmits the same two photos.
  if (refinement) return submitRefinement(next);
  if (candidate.kind === 'animation') return submitAnimation(next);

  try {
    await submitCandidate(next, await generationInputFor(next.jobId));
  } catch (err) {
    console.error('[fan-in] retry input unavailable', { candidateId: next.id, err: err instanceof Error ? err.message : err });
    await failCandidate(next, 'GENERATION_FAILED');
  }
}

const FINAL_FAILURE = {
  generation: 'GENERATION_FAILED',
  refinement: 'REFINEMENT_FAILED',
  animation: 'ANIMATION_FAILED',
} as const satisfies Record<Candidate['kind'], ErrorCode>;

async function failCandidate(candidate: Candidate, code: ErrorCode): Promise<void> {
  await db
    .update(candidates)
    .set({ status: 'failed', errorCode: code, completedAt: new Date() })
    .where(pendingAttempt(candidate));
}

const pendingAttempt = (candidate: Pick<Candidate, 'id' | 'attempt'>) =>
  and(eq(candidates.id, candidate.id), eq(candidates.attempt, candidate.attempt), eq(candidates.status, 'pending'));

/**
 * The fan-in. Under the job row lock, checks whether every candidate of the round has finished
 * and the round is still the job's current `generating` round. Exactly one caller sees that and
 * moves the job to `ranking` (or fails it when nothing succeeded); every other caller no-ops.
 */
export async function maybeFinishRound(roundId: string): Promise<void> {
  const outcome = await db.transaction(async (tx) => {
    const [round] = await tx.select().from(jobRounds).where(eq(jobRounds.id, roundId));
    if (!round) return 'noop';
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, round.jobId)).for('update');
    if (!job || job.status !== 'running' || job.stage !== 'generating' || job.currentRound !== round.round) return 'noop';

    // Read after taking the lock: every candidate write committed before it is visible here.
    const [counts] = await tx
      .select({
        pending: sql<number>`count(*) filter (where ${candidates.status} = 'pending')`.mapWith(Number),
        succeeded: sql<number>`count(*) filter (where ${candidates.status} = 'succeeded')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${candidates.status} = 'failed')`.mapWith(Number),
        blocked: sql<number>`count(*) filter (where ${candidates.status} = 'failed' and ${candidates.errorCode} = 'CONTENT_BLOCKED')`.mapWith(Number),
      })
      .from(candidates)
      .where(eq(candidates.roundId, roundId));
    if (counts.pending > 0 || counts.succeeded + counts.failed === 0) return 'noop';

    if (counts.succeeded === 0) {
      await failJob(job.id, roundId, counts.blocked === counts.failed ? 'CONTENT_BLOCKED' : 'GENERATION_FAILED', tx);
      return 'failed';
    }
    await tx.update(jobs).set({ stage: 'ranking' }).where(eq(jobs.id, job.id));
    return 'ranking';
  });

  if (outcome !== 'ranking') return;
  await markStageEnd(roundId, 'generating');
  await markStageStart(roundId, 'ranking');
  await onRoundGenerated(roundId);
}
