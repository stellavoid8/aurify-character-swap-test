import 'server-only';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { candidates, jobs, type Candidate, type Job } from '@/lib/db/schema';
import { AppError } from '@/lib/errors';

const uuid = z.uuid();

/** This session's job. Throws JOB_NOT_FOUND for a malformed id or another session's job alike. */
export async function getJobForSession(sid: string, jobId: string): Promise<Job> {
  if (!uuid.safeParse(jobId).success) throw new AppError('JOB_NOT_FOUND', { detail: 'malformed job id' });
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.sessionId, sid)));
  if (!job) throw new AppError('JOB_NOT_FOUND', { detail: 'job missing or foreign' });
  return job;
}

/** A candidate of one of this session's jobs. Throws JOB_NOT_FOUND otherwise. */
export async function getCandidateForSession(sid: string, candidateId: string): Promise<Candidate> {
  if (!uuid.safeParse(candidateId).success) throw new AppError('JOB_NOT_FOUND', { detail: 'malformed candidate id' });
  const [row] = await db
    .select({ candidate: candidates })
    .from(candidates)
    .innerJoin(jobs, eq(jobs.id, candidates.jobId))
    .where(and(eq(candidates.id, candidateId), eq(jobs.sessionId, sid)));
  if (!row) throw new AppError('JOB_NOT_FOUND', { detail: 'candidate missing or foreign' });
  return row.candidate;
}
