import { sql } from 'drizzle-orm';
import { jobRounds, jobs, uploads } from '@/lib/db/schema';
import type { TestDb } from './db';

/** A job (with its template upload) owned by `sid`, for tests that need job_rounds rows. */
export async function seedJob(db: TestDb, sid: string): Promise<string> {
  const [template] = await db
    .insert(uploads)
    .values({ sessionId: sid, kind: 'template', rawUrl: 'https://example.test/raw.jpg', width: 1, height: 1, bytes: 1 })
    .returning({ id: uploads.id });
  const [job] = await db
    .insert(jobs)
    .values({ sessionId: sid, templateUploadId: template.id, userUploadIds: [] })
    .returning({ id: jobs.id });
  return job.id;
}

/**
 * Inserts `count` rounds for `sid`. `startedAt` is a SQL expression evaluated by the database,
 * so "today" and "yesterday" use the same clock as the rate limiter.
 */
export async function seedRounds(
  db: TestDb,
  sid: string,
  count: number,
  startedAt = sql`now()`,
): Promise<string[]> {
  const jobId = await seedJob(db, sid);
  const rows = await db
    .insert(jobRounds)
    .values(Array.from({ length: count }, (_, i) => ({ jobId, sessionId: sid, round: i + 1, kind: 'generation' as const, startedAt })))
    .returning({ id: jobRounds.id });
  return rows.map((row) => row.id);
}
