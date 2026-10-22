import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobRounds, jobs } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedJob } from './helpers/seed';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('GLOBAL_DAILY_UNITS', '1000');

const { enforceTimeout } = await import('@/lib/pipeline/timeout');
const { getJobView } = await import('@/server/jobs/view');

const SID = '99999999-9999-4999-8999-999999999999';

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads cascade`);
  vi.restoreAllMocks();
});

/** A running job in `generating` whose deadline is `secondsFromNow` away (negative: already past). */
async function runningJob(secondsFromNow: number) {
  const jobId = await seedJob(testDb, SID);
  await testDb
    .update(jobs)
    .set({ status: 'running', stage: 'generating', currentRound: 1, deadlineAt: sql`now() + make_interval(secs => ${secondsFromNow})` })
    .where(eq(jobs.id, jobId));
  await testDb.insert(jobRounds).values({ jobId, sessionId: SID, round: 1, kind: 'generation' });
  const [job] = await testDb.select().from(jobs).where(eq(jobs.id, jobId));
  return job;
}

const roundOf = async (jobId: string) => (await testDb.select().from(jobRounds).where(eq(jobRounds.jobId, jobId)))[0];

describe('enforceTimeout', () => {
  it('times out a running job past its deadline exactly once under concurrent reads', async () => {
    const job = await runningJob(-5);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const results = await Promise.all(Array.from({ length: 5 }, () => enforceTimeout(job)));

    expect(results.every((r) => r.status === 'timed_out' && r.stage === 'done' && r.errorCode === 'JOB_TIMED_OUT')).toBe(true);
    expect(new Set(results.map((r) => r.finishedAt?.getTime())).size).toBe(1);
    expect(info.mock.calls.filter(([msg]) => msg === '[timeout] job timed out')).toHaveLength(1);
    expect(await roundOf(job.id)).toMatchObject({ status: 'timed_out' });
  });

  it('leaves a job inside its deadline alone', async () => {
    const job = await runningJob(60);
    expect(await enforceTimeout(job)).toBe(job);
    expect((await roundOf(job.id)).status).toBe('running');
  });

  it('never times out a finished job', async () => {
    const job = await runningJob(-5);
    await testDb.update(jobs).set({ status: 'succeeded', stage: 'done' }).where(eq(jobs.id, job.id));
    // The caller's copy is stale (still `running`); the conditional update sees the real status.
    const result = await enforceTimeout(job);
    expect(result.status).toBe('succeeded');
  });

  it('is applied when the job view is read', async () => {
    const job = await runningJob(-5);
    const view = await getJobView(SID, job.id);
    expect(view).toMatchObject({
      status: 'timed_out',
      stage: 'done',
      error: { code: 'JOB_TIMED_OUT' },
    });
  });
});
