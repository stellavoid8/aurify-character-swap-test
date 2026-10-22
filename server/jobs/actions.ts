'use server';

import { and, eq, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { jobs } from '@/lib/db/schema';
import { AppError, toActionError } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import type { ActionResult } from '@/lib/types';
import { getCandidateForSession, getJobForSession } from './queries';

const chooseSchema = z.object({
  jobId: z.uuid(),
  candidateId: z.uuid(),
});

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
