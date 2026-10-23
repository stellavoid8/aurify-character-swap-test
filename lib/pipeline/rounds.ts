import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../db';
import { jobRounds, jobs } from '../db/schema';
import { AppError } from '../errors';
import { checkUnits } from '../rate-limit';
import type { RoundKind } from '../types';

/** The stage each round kind starts in. */
export const FIRST_STAGE = { generation: 'analyzing', refinement: 'refining', animation: 'animating' } as const satisfies Record<RoundKind, string>;

/**
 * Takes `units` rate-limit units and opens the job's next round, inside the caller's transaction.
 * Shared by createJob, Try again, Fix the face, Animate this one and the orchestrator's chaining
 * of a video job's animation round. The first stage's start time is written with the row, because
 * telemetry helpers can't see it until the transaction commits.
 */
export async function startRound(
  tx: Executor,
  { jobId, sid, kind, units = 1 }: { jobId: string; sid: string; kind: RoundKind; units?: number },
): Promise<{ roundId: string; round: number }> {
  await checkUnits(sid, tx, units);
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
      units,
      status: 'running',
      stageTimings: sql`jsonb_build_object(${stage}::text, jsonb_build_object(
        'startedAt', to_jsonb(clock_timestamp()), 'endedAt', null, 'ms', null))`,
    })
    .returning({ id: jobRounds.id });
  return { roundId: row.id, round: job.round };
}
