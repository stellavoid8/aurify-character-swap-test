import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { jobRounds, providerCalls } from './db/schema';

/**
 * One `provider_calls` row per external call (fal, Anthropic) and per local face-model pass,
 * plus per-stage timings on `job_rounds.stage_timings`.
 * Telemetry never breaks the pipeline: write failures are logged and swallowed.
 */

export type CallRecord = {
  jobId?: string | null;
  roundId?: string | null;
  candidateId?: string | null;
  provider: 'fal' | 'anthropic' | 'local';
  model: string;
  stage: string;
  requestId?: string | null;
  status: 'ok' | 'error';
  latencyMs: number;
  costUsdMicros: number;
  meta?: Record<string, unknown>;
};

export async function recordCall(call: CallRecord): Promise<void> {
  try {
    await db.insert(providerCalls).values({
      jobId: call.jobId ?? null,
      roundId: call.roundId ?? null,
      candidateId: call.candidateId ?? null,
      provider: call.provider,
      model: call.model,
      stage: call.stage,
      requestId: call.requestId ?? null,
      status: call.status,
      latencyMs: Math.round(call.latencyMs),
      costUsdMicros: Math.round(call.costUsdMicros),
      meta: call.meta ?? {},
    });
  } catch (err) {
    console.error('[telemetry] recordCall failed', { stage: call.stage, provider: call.provider, err });
  }
}

// Each update rewrites only `stage_timings[stage]` with jsonb_set in a single statement, so concurrent
// writers for different stages (e.g. parallel webhooks) never overwrite each other.
// clock_timestamp() rather than now(): now() is frozen at the start of the surrounding transaction.

/** Sets `stage_timings[stage] = { startedAt: now, endedAt: null, ms: null }`. */
export async function markStageStart(roundId: string, stage: string): Promise<void> {
  try {
    await db
      .update(jobRounds)
      .set({
        stageTimings: sql`jsonb_set(${jobRounds.stageTimings}, array[${stage}]::text[], jsonb_build_object(
          'startedAt', to_jsonb(clock_timestamp()), 'endedAt', null, 'ms', null))`,
      })
      .where(eq(jobRounds.id, roundId));
  } catch (err) {
    console.error('[telemetry] markStageStart failed', { stage, err });
  }
}

/** Sets `endedAt` and `ms` on `stage_timings[stage]`. `ms` stays null if the stage was never started. */
export async function markStageEnd(roundId: string, stage: string): Promise<void> {
  try {
    const started = sql`(${jobRounds.stageTimings} -> ${stage} ->> 'startedAt')::timestamptz`;
    await db
      .update(jobRounds)
      .set({
        stageTimings: sql`jsonb_set(${jobRounds.stageTimings}, array[${stage}]::text[], jsonb_build_object(
          'startedAt', ${jobRounds.stageTimings} -> ${stage} -> 'startedAt',
          'endedAt', to_jsonb(clock_timestamp()),
          'ms', round(extract(epoch from clock_timestamp() - ${started}) * 1000)::int))`,
      })
      .where(eq(jobRounds.id, roundId));
  } catch (err) {
    console.error('[telemetry] markStageEnd failed', { stage, err });
  }
}

/** Runs `fn` between markStageStart and markStageEnd. The end is recorded even if `fn` throws. */
export async function timeStage<T>(roundId: string, stage: string, fn: () => Promise<T>): Promise<T> {
  await markStageStart(roundId, stage);
  try {
    return await fn();
  } finally {
    await markStageEnd(roundId, stage);
  }
}
