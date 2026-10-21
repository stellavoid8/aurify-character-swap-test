import 'server-only';
import { gte, sql } from 'drizzle-orm';
import { db, type Executor } from './db';
import { jobRounds } from './db/schema';
import { AppError } from './errors';
import { SESSION_DAILY_UNITS, globalDailyUnits } from './limits';

/** Start of the current UTC day as a timestamptz, independent of the connection's TimeZone setting. */
const startOfUtcDay = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;

/**
 * Throws RATE_LIMITED_SESSION / RATE_LIMITED_GLOBAL when today's (UTC) `job_rounds` count is at the cap.
 * Pass the transaction that will insert the new round: inside it, a transaction-level advisory lock
 * serializes concurrent check-then-insert so two requests can't both take the last unit.
 */
export async function checkUnits(sid: string, tx?: Executor): Promise<void> {
  const exec = tx ?? db;
  if (tx) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('job_rounds_units'))`);

  const [counts] = await exec
    .select({
      session: sql<number>`count(*) filter (where ${jobRounds.sessionId} = ${sid})`.mapWith(Number),
      global: sql<number>`count(*)`.mapWith(Number),
    })
    .from(jobRounds)
    .where(gte(jobRounds.startedAt, startOfUtcDay));

  if (counts.session >= SESSION_DAILY_UNITS) throw new AppError('RATE_LIMITED_SESSION');
  if (counts.global >= (await globalDailyUnits())) throw new AppError('RATE_LIMITED_GLOBAL');
}
