import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '@/lib/db';
import { jobRounds, jobs } from '@/lib/db/schema';
import { AppError } from '@/lib/errors';
import { JOB_TIMEOUT_MS, MAX_USER_PHOTOS } from '@/lib/limits';
import { checkUnits } from '@/lib/rate-limit';
import { getUploadsForSession } from '@/server/uploads/queries';

export const createJobSchema = z.object({
  templateUploadId: z.uuid(),
  userUploadIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_USER_PHOTOS)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'duplicate photo' }),
});
export type CreateJobInput = z.input<typeof createJobSchema>;

/** The stage each round kind starts in. */
const FIRST_STAGE = { generation: 'analyzing', refinement: 'refining' } as const;

/**
 * Takes one rate-limit unit and opens the job's next round, inside the caller's transaction.
 * Shared by createJob, retryJob and refineCandidate. The first stage's start time is written with
 * the row, because telemetry helpers can't see it until the transaction commits.
 */
export async function startRound(
  tx: Executor,
  { jobId, sid, kind }: { jobId: string; sid: string; kind: 'generation' | 'refinement' },
): Promise<{ roundId: string; round: number }> {
  await checkUnits(sid, tx);
  const [job] = await tx
    .update(jobs)
    .set({ currentRound: sql`${jobs.currentRound} + 1` })
    .where(eq(jobs.id, jobId))
    .returning({ round: jobs.currentRound });
  if (!job) throw new AppError('JOB_NOT_FOUND', { detail: 'startRound: job missing' });

  const stage = FIRST_STAGE[kind];
  const [row] = await tx
    .insert(jobRounds)
    .values({
      jobId,
      sessionId: sid,
      round: job.round,
      kind,
      status: 'running',
      stageTimings: sql`jsonb_build_object(${stage}::text, jsonb_build_object(
        'startedAt', to_jsonb(clock_timestamp()), 'endedAt', null, 'ms', null))`,
    })
    .returning({ id: jobRounds.id });
  return { roundId: row.id, round: job.round };
}

/**
 * Validates the photos and opens round 1. Fast by design (no provider calls): the caller schedules
 * `runGenerationRound` in after() with the returned ids.
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

  return db.transaction(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({
        sessionId: sid,
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
