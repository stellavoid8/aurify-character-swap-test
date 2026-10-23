import 'server-only';
import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, type Executor } from '../db';
import { candidates, jobs, uploads, type Candidate } from '../db/schema';
import { AppError } from '../errors';
import { faceEngine } from '../face';
import { runUtility, submitToQueue } from '../fal/client';
import { buildAnimateInput, buildFrameInput, FFMPEG_EXTRACT_FRAME, parseFrameOutput, VIDEO_MODEL, type FrameType } from '../fal/models';
import { ANIMATION_RESOLUTION, ANIMATION_ROUND_UNITS, VIDEO_UTILITY_TIMEOUT_MS } from '../limits';
import { deleteObjects } from '../storage';
import { webhookUrlFor } from '../webhook-token';
import { finishAnimation } from './orchestrator';
import { scoreVideoIdentity } from './rank';
import { startRound } from './rounds';

/**
 * Animation rounds of a video job (docs/decisions/0002-video-swap-architecture.md): one candidate
 * that sends the template clip and a finished still (the "driving still") to VIDEO_MODEL. Its
 * webhook goes through the same fan-in as every other candidate. On success the video is scored at
 * three points and becomes the job's chosen version; a failure never fails the job, whose stills stand.
 */

/** Same range as the generation seeds (Postgres `int`). */
const SEED_MAX = 2 ** 31 - 1;
const SCORE_FRAMES: FrameType[] = ['first', 'middle', 'last'];

/**
 * Opens an animation round of `parent` with one pending candidate, inside the caller's transaction.
 * The caller has already put the job in `animating` with an ANIMATION_TIMEOUT_MS deadline.
 * The candidate's `image_url` is the driving still, which the result screen uses as the video's poster.
 */
export async function openAnimationRound(
  tx: Executor,
  { jobId, sid, parent }: { jobId: string; sid: string; parent: Pick<Candidate, 'id' | 'imageUrl'> },
): Promise<{ roundId: string; round: number; candidateId: string }> {
  if (!parent.imageUrl) throw new AppError('INVALID_STATE', { detail: 'animation parent has no image' });
  const { roundId, round } = await startRound(tx, { jobId, sid, kind: 'animation', units: ANIMATION_ROUND_UNITS });
  const [candidate] = await tx
    .insert(candidates)
    .values({
      jobId,
      roundId,
      kind: 'animation',
      parentCandidateId: parent.id,
      model: VIDEO_MODEL,
      seed: randomInt(0, SEED_MAX),
      attempt: 1,
      status: 'pending',
      imageUrl: parent.imageUrl,
    })
    .returning({ id: candidates.id });
  return { roundId, round, candidateId: candidate.id };
}

export async function runAnimationRound({ jobId, roundId, candidateId }: { jobId: string; roundId: string; candidateId: string }): Promise<void> {
  try {
    const [candidate] = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, candidateId), eq(candidates.roundId, roundId), eq(candidates.jobId, jobId)));
    if (!candidate) throw new AppError('JOB_NOT_FOUND', { detail: `runAnimationRound: ${candidateId} missing` });
    await submitAnimation(candidate);
    // A refused submission is already a failed candidate; a webhook may also have beaten us here.
    await settleAnimation(candidateId);
  } catch (err) {
    console.error('[animate] round failed', { jobId, roundId, err: err instanceof Error ? err.message : err });
    await finishAnimation(jobId, roundId, 'failed').catch((finishErr) => console.error('[animate] finish failed', { jobId, finishErr }));
  }
}

/** The replace model's input: the job's normalized template clip and the candidate's driving still. */
async function animateInputFor(candidate: Candidate): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ videoUrl: uploads.videoUrl })
    .from(jobs)
    .innerJoin(uploads, eq(uploads.id, jobs.templateUploadId))
    .where(eq(jobs.id, candidate.jobId));
  if (!row?.videoUrl || !candidate.imageUrl) throw new AppError('UPLOAD_NOT_FOUND', { detail: `animation ${candidate.id}: clip or still gone` });
  return buildAnimateInput({ videoUrl: row.videoUrl, imageUrl: candidate.imageUrl, seed: candidate.seed, resolution: ANIMATION_RESOLUTION });
}

/**
 * Submits one attempt of an animation candidate (first try, or the fan-in's automatic retry) and
 * stores its `fal_request_id`. A rejected submission marks the attempt failed instead of throwing.
 */
export async function submitAnimation(candidate: Candidate): Promise<void> {
  try {
    const { requestId } = await submitToQueue({
      model: VIDEO_MODEL,
      input: await animateInputFor(candidate),
      webhookUrl: webhookUrlFor(candidate.id, candidate.attempt),
      context: { jobId: candidate.jobId, roundId: candidate.roundId, candidateId: candidate.id, stage: 'animating' },
    });
    await db.update(candidates).set({ falRequestId: requestId, submittedAt: new Date() }).where(eq(candidates.id, candidate.id));
  } catch (err) {
    const code = err instanceof AppError && err.code === 'CONTENT_BLOCKED' ? 'CONTENT_BLOCKED' : 'ANIMATION_FAILED';
    if (!(err instanceof AppError)) console.error('[animate] submit failed', { candidateId: candidate.id, err });
    await db
      .update(candidates)
      .set({ status: 'failed', errorCode: code, completedAt: new Date() })
      .where(and(eq(candidates.id, candidate.id), eq(candidates.attempt, candidate.attempt), eq(candidates.status, 'pending')));
  }
}

/**
 * The animation fan-in, called after each event on its candidate: scores a success, ends the round
 * on a failure, and does nothing while an attempt is still out or once the round is over.
 */
export async function settleAnimation(candidateId: string): Promise<void> {
  const [row] = await db
    .select({ candidate: candidates, job: jobs })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(eq(candidates.id, candidateId));
  if (!row || row.candidate.status === 'pending') return;
  if (row.job.status !== 'running' || row.job.stage !== 'animating') return;

  if (row.candidate.status === 'succeeded') await scoreAnimation(row.candidate);
  else await finishAnimation(row.candidate.jobId, row.candidate.roundId, 'failed');
}

/** Stores the video's likeness (its worst of three frames) and ends the round with it as the chosen version. */
async function scoreAnimation(candidate: Candidate): Promise<void> {
  const frameUrls = await grabFrames(candidate);
  const identity = frameUrls.length > 0 ? await scoreVideoIdentity(candidate, frameUrls) : null;
  await deleteObjects(frameUrls).catch(() => undefined);
  await db
    .update(candidates)
    .set({ identityScore: identity, scorer: identity === null ? null : faceEngine.name })
    .where(eq(candidates.id, candidate.id));
  await finishAnimation(candidate.jobId, candidate.roundId, 'succeeded', candidate.id);
}

/** Frames of the result video to score. A failed grab only drops that frame: scoring is never a reason to fail. */
async function grabFrames(candidate: Candidate): Promise<string[]> {
  const context = { jobId: candidate.jobId, roundId: candidate.roundId, candidateId: candidate.id, stage: 'animating' };
  const urls = await Promise.all(
    SCORE_FRAMES.map(async (frame) => {
      try {
        const output = await runUtility({
          model: FFMPEG_EXTRACT_FRAME,
          input: buildFrameInput({ videoUrl: candidate.videoUrl!, frame }),
          timeoutMs: VIDEO_UTILITY_TIMEOUT_MS,
          context,
        });
        return parseFrameOutput(output).imageUrl;
      } catch (err) {
        console.error('[animate] frame grab failed', { candidateId: candidate.id, frame, err: err instanceof Error ? err.message : err });
        return null;
      }
    }),
  );
  return urls.filter((url): url is string => url !== null);
}
