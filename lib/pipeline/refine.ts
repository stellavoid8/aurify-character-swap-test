import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { candidates, jobs, uploads, type Candidate } from '../db/schema';
import { AppError } from '../errors';
import { faceEngine } from '../face';
import { submitToQueue } from '../fal/client';
import { buildRefineInput, REFINE_MODEL } from '../fal/models';
import { webhookUrlFor } from '../webhook-token';
import { finishRefinement } from './orchestrator';
import { scoreIdentity } from './rank';

/**
 * Fix the face: a refinement round has one face-swap candidate that puts the reference photo's
 * face onto the chosen result. Its webhook goes through the same fan-in as generation; on success
 * it is scored like a ranked result so before and after compare. A refinement never fails the
 * job: the picture it started from is still there.
 */

export async function runRefinementRound({ jobId, roundId, candidateId }: { jobId: string; roundId: string; candidateId: string }): Promise<void> {
  try {
    const [candidate] = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, candidateId), eq(candidates.roundId, roundId), eq(candidates.jobId, jobId)));
    if (!candidate) throw new AppError('JOB_NOT_FOUND', { detail: `runRefinementRound: ${candidateId} missing` });
    await submitRefinement(candidate);
    // A refused submission is already a failed candidate; a webhook may also have beaten us here.
    await settleRefinement(candidateId);
  } catch (err) {
    console.error('[refine] round failed', { jobId, roundId, err: err instanceof Error ? err.message : err });
    await finishRefinement(jobId, roundId, 'failed').catch((finishErr) => console.error('[refine] finish failed', { jobId, finishErr }));
  }
}

/** The face-swap input: the parent result as the target, the job's reference photo as the face. */
async function refineInputFor(candidate: Candidate): Promise<Record<string, unknown>> {
  const [[parent], [job]] = await Promise.all([
    candidate.parentCandidateId ? db.select().from(candidates).where(eq(candidates.id, candidate.parentCandidateId)) : [],
    db.select().from(jobs).where(eq(jobs.id, candidate.jobId)),
  ]);
  const faceId = job?.referenceUploadId ?? job?.userUploadIds[0];
  const [face] = faceId ? await db.select().from(uploads).where(eq(uploads.id, faceId)) : [];
  if (!parent?.imageUrl || !face?.url) throw new AppError('UPLOAD_NOT_FOUND', { detail: `refinement ${candidate.id}: parent or face photo gone` });
  return buildRefineInput({ targetUrl: parent.imageUrl, faceUrl: face.url });
}

/**
 * Submits one attempt of a refinement candidate (first try, or the fan-in's automatic retry) and
 * stores its `fal_request_id`. A rejected submission marks the attempt failed instead of throwing.
 */
export async function submitRefinement(candidate: Candidate): Promise<void> {
  try {
    const { requestId } = await submitToQueue({
      model: REFINE_MODEL,
      input: await refineInputFor(candidate),
      webhookUrl: webhookUrlFor(candidate.id, candidate.attempt),
      context: { jobId: candidate.jobId, roundId: candidate.roundId, candidateId: candidate.id, stage: 'refining' },
    });
    await db.update(candidates).set({ falRequestId: requestId, submittedAt: new Date() }).where(eq(candidates.id, candidate.id));
  } catch (err) {
    const code = err instanceof AppError && err.code === 'CONTENT_BLOCKED' ? 'CONTENT_BLOCKED' : 'REFINEMENT_FAILED';
    if (!(err instanceof AppError)) console.error('[refine] submit failed', { candidateId: candidate.id, err });
    await db
      .update(candidates)
      .set({ status: 'failed', errorCode: code, completedAt: new Date() })
      .where(and(eq(candidates.id, candidate.id), eq(candidates.attempt, candidate.attempt), eq(candidates.status, 'pending')));
  }
}

/**
 * The refinement fan-in, called after each event on its candidate: scores a success, ends the
 * round on a failure, and does nothing while an attempt is still out or once the round is over.
 */
export async function settleRefinement(candidateId: string): Promise<void> {
  const [row] = await db
    .select({ candidate: candidates, job: jobs })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(eq(candidates.id, candidateId));
  if (!row || row.candidate.status === 'pending') return;
  if (row.job.status !== 'running' || row.job.stage !== 'refining') return;

  if (row.candidate.status === 'succeeded') await scoreRefinement(candidateId);
  else await finishRefinement(row.candidate.jobId, row.candidate.roundId, 'failed');
}

/** Stores the refined result's likeness and ends the round. The chosen version stays as it was. */
export async function scoreRefinement(candidateId: string): Promise<void> {
  const [candidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
  if (!candidate) return;
  const identity = await scoreIdentity(candidate, 'refining');
  await db
    .update(candidates)
    .set({ identityScore: identity, scorer: identity === null ? null : faceEngine.name })
    .where(eq(candidates.id, candidate.id));
  await finishRefinement(candidate.jobId, candidate.roundId, 'succeeded');
}
