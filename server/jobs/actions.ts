'use server';

import { and, eq, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { jobs } from '@/lib/db/schema';
import { AppError, toActionError } from '@/lib/errors';
import { runAnimationRound } from '@/lib/pipeline/animate';
import { runGenerationRound } from '@/lib/pipeline/generate';
import { runRefinementRound } from '@/lib/pipeline/refine';
import { requireSession } from '@/lib/session';
import type { ActionResult } from '@/lib/types';
import { startAnimation, startRefinement, startRetry } from './create';
import { getCandidateForSession, getJobForSession } from './queries';

const chooseSchema = z.object({
  jobId: z.uuid(),
  candidateId: z.uuid(),
});
const retrySchema = z.object({ jobId: z.uuid() });
const refineSchema = chooseSchema;
const animateSchema = chooseSchema;

/** Makes a finished version the one the result screen, Download and Share use. */
export async function chooseCandidate(
  input: z.input<typeof chooseSchema>,
): Promise<ActionResult<{ chosenCandidateId: string }>> {
  try {
    const { sid } = await requireSession();
    const { jobId, candidateId } = chooseSchema.parse(input);
    const job = await getJobForSession(sid, jobId);
    const candidate = await getCandidateForSession(sid, candidateId);
    if (candidate.jobId !== job.id) throw new AppError('JOB_NOT_FOUND', { detail: 'candidate of another job' });
    if (candidate.status !== 'succeeded') throw new AppError('INVALID_STATE', { detail: 'candidate not succeeded' });

    // The status check is in the update itself, so a round that starts meanwhile wins.
    const updated = await db
      .update(jobs)
      .set({ chosenCandidateId: candidate.id })
      .where(and(eq(jobs.id, job.id), eq(jobs.sessionId, sid), ne(jobs.status, 'running')))
      .returning({ id: jobs.id });
    if (updated.length === 0) throw new AppError('INVALID_STATE', { detail: 'job is running' });

    revalidatePath(`/jobs/${job.id}`);
    return { ok: true, data: { chosenCandidateId: candidate.id } };
  } catch (err) {
    return toActionError(err);
  }
}

/** Try again: a new version in a new round; the earlier ones stay. Takes one daily unit. */
export async function retryJob(input: z.input<typeof retrySchema>): Promise<ActionResult<{ round: number }>> {
  try {
    const { sid } = await requireSession();
    const { jobId } = retrySchema.parse(input);
    const { roundId, round } = await startRetry(sid, jobId);
    after(() => runGenerationRound({ jobId, roundId }));
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, data: { round } };
  } catch (err) {
    return toActionError(err);
  }
}

/** Fix the face: a face-only refinement of one finished version. Takes one daily unit. */
export async function refineCandidate(
  input: z.input<typeof refineSchema>,
): Promise<ActionResult<{ round: number; candidateId: string }>> {
  try {
    const { sid } = await requireSession();
    const { jobId, candidateId: parentId } = refineSchema.parse(input);
    const { roundId, round, candidateId } = await startRefinement(sid, { jobId, candidateId: parentId });
    after(() => runRefinementRound({ jobId, roundId, candidateId }));
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, data: { round, candidateId } };
  } catch (err) {
    return toActionError(err);
  }
}

/** Animate this one: a video of one finished still of a video job. Takes ANIMATION_ROUND_UNITS daily units. */
export async function animateCandidate(
  input: z.input<typeof animateSchema>,
): Promise<ActionResult<{ round: number; candidateId: string }>> {
  try {
    const { sid } = await requireSession();
    const { jobId, candidateId: parentId } = animateSchema.parse(input);
    const { roundId, round, candidateId } = await startAnimation(sid, { jobId, candidateId: parentId });
    after(() => runAnimationRound({ jobId, roundId, candidateId }));
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, data: { round, candidateId } };
  } catch (err) {
    return toActionError(err);
  }
}
