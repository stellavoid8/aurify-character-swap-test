import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { candidates, jobRounds, jobs, uploads } from '@/lib/db/schema';
import { DEFAULT_ANIMATION_MS_PER_SECOND, DEFAULT_ETA_MS, ETA_CACHE_SECONDS, ETA_MIN_SAMPLES, ETA_WINDOW_DAYS } from '@/lib/limits';

/**
 * Typical time for a generation round: the median of recent succeeded rounds, start to finish.
 * Rounds ranked by the mock face engine ran against mock providers and would skew it, so they
 * don't count. Below ETA_MIN_SAMPLES samples the default stands in.
 */
export async function computeEtaMs(): Promise<number> {
  const [row] = await db
    .select({
      samples: sql<number>`count(*)`.mapWith(Number),
      p50: sql<number | null>`percentile_cont(0.5) within group (
        order by extract(epoch from ${jobRounds.finishedAt} - ${jobRounds.startedAt}) * 1000)`.mapWith((v) =>
        v === null ? null : Number(v),
      ),
    })
    .from(jobRounds)
    .where(
      and(
        eq(jobRounds.kind, 'generation'),
        eq(jobRounds.status, 'succeeded'),
        isNotNull(jobRounds.finishedAt),
        gt(jobRounds.startedAt, sql`now() - make_interval(days => ${ETA_WINDOW_DAYS})`),
        sql`not exists (select 1 from ${candidates} where ${candidates.roundId} = ${jobRounds.id} and ${candidates.scorer} = 'mock')`,
      ),
    );
  if (!row || row.samples < ETA_MIN_SAMPLES || row.p50 === null) return DEFAULT_ETA_MS;
  return Math.round(row.p50);
}

/** `computeEtaMs`, cached for ETA_CACHE_SECONDS and refreshed by `revalidateTag('eta')` when a round finishes. */
export const getEtaMs = unstable_cache(computeEtaMs, ['eta-ms'], { revalidate: ETA_CACHE_SECONDS, tags: ['eta'] });

/**
 * Typical animation time per second of template clip: the median over recent succeeded animation
 * rounds of (round time ÷ clip seconds), so a 15 s clip's estimate is three times a 5 s clip's.
 * Mock-scored rounds don't count. Below ETA_MIN_SAMPLES samples the default stands in.
 */
export async function computeAnimationMsPerSecond(): Promise<number> {
  const [row] = await db
    .select({
      samples: sql<number>`count(*)`.mapWith(Number),
      p50: sql<number | null>`percentile_cont(0.5) within group (
        order by extract(epoch from ${jobRounds.finishedAt} - ${jobRounds.startedAt}) * 1000 / (${uploads.durationMs} / 1000.0))`.mapWith((v) =>
        v === null ? null : Number(v),
      ),
    })
    .from(jobRounds)
    .innerJoin(jobs, eq(jobs.id, jobRounds.jobId))
    .innerJoin(uploads, eq(uploads.id, jobs.templateUploadId))
    .where(
      and(
        eq(jobRounds.kind, 'animation'),
        eq(jobRounds.status, 'succeeded'),
        isNotNull(jobRounds.finishedAt),
        gt(uploads.durationMs, 0),
        gt(jobRounds.startedAt, sql`now() - make_interval(days => ${ETA_WINDOW_DAYS})`),
        sql`not exists (select 1 from ${candidates} where ${candidates.roundId} = ${jobRounds.id} and ${candidates.scorer} = 'mock')`,
      ),
    );
  if (!row || row.samples < ETA_MIN_SAMPLES || row.p50 === null) return DEFAULT_ANIMATION_MS_PER_SECOND;
  return Math.round(row.p50);
}

/** `computeAnimationMsPerSecond`, cached like `getEtaMs` and refreshed when an animation finishes. */
export const getAnimationMsPerSecond = unstable_cache(computeAnimationMsPerSecond, ['animation-ms-per-second'], {
  revalidate: ETA_CACHE_SECONDS,
  tags: ['eta'],
});
