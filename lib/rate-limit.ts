import 'server-only';
import { gte, sql } from 'drizzle-orm';
import { db, type Executor } from './db';
import { jobRounds } from './db/schema';
import { AppError } from './errors';
import { SESSION_DAILY_UNITS, globalDailyUnits } from './limits';

/** Start of the current UTC day as a timestamptz, independent of the connection's TimeZone setting. */
const startOfUtcDay = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;

/**
 * Throws RATE_LIMITED_SESSION / RATE_LIMITED_GLOBAL when today's (UTC) units plus `units` would pass
 * the cap. A round's weight is `job_rounds.units` (an animation round counts ANIMATION_ROUND_UNITS).
 * Pass the transaction that will insert the new round: inside it, a transaction-level advisory lock
 * serializes concurrent check-then-insert so two requests can't both take the last unit.
 */
export async function checkUnits(sid: string, tx?: Executor, units = 1): Promise<void> {
  if (tx) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('job_rounds_units'))`);
  const counts = await countToday(sid, tx ?? db);
  if (counts.session + units > SESSION_DAILY_UNITS) throw new AppError('RATE_LIMITED_SESSION');
  if (counts.global + units > (await globalDailyUnits())) throw new AppError('RATE_LIMITED_GLOBAL');
}

/** Units this session can still start today (UTC), counting the global cap too. */
export async function unitsLeftToday(sid: string): Promise<number> {
  const counts = await countToday(sid, db);
  return Math.max(0, Math.min(SESSION_DAILY_UNITS - counts.session, (await globalDailyUnits()) - counts.global));
}

async function countToday(sid: string, exec: Executor): Promise<{ session: number; global: number }> {
  const [counts] = await exec
    .select({
      session: sql<number>`coalesce(sum(${jobRounds.units}) filter (where ${jobRounds.sessionId} = ${sid}), 0)`.mapWith(Number),
      global: sql<number>`coalesce(sum(${jobRounds.units}), 0)`.mapWith(Number),
    })
    .from(jobRounds)
    .where(gte(jobRounds.startedAt, startOfUtcDay));
  return counts;
}
