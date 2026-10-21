import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobRounds } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedJob, seedRounds } from './helpers/seed';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

const GLOBAL_CAP = 30;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  vi.stubEnv('GLOBAL_DAILY_UNITS', String(GLOBAL_CAP));
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads cascade`);
});

const { checkUnits } = await import('@/lib/rate-limit');

describe('checkUnits', () => {
  it('blocks a session at 20 rounds today while other sessions are allowed', async () => {
    await seedRounds(testDb, A, 19);
    await expect(checkUnits(A)).resolves.toBeUndefined();

    await seedRounds(testDb, A, 1);
    await expect(checkUnits(A)).rejects.toMatchObject({ code: 'RATE_LIMITED_SESSION', status: 429 });
    await expect(checkUnits(B)).resolves.toBeUndefined();
  });

  it("ignores rounds from before today's UTC midnight", async () => {
    const yesterday = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '1 minute'`;
    await seedRounds(testDb, A, 25, yesterday);
    await expect(checkUnits(A)).resolves.toBeUndefined();

    // UTC midnight counts as today regardless of the connection's time zone.
    await testDb.execute(sql`set time zone 'America/Los_Angeles'`);
    try {
      const midnight = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
      await seedRounds(testDb, A, 20, midnight);
      await expect(checkUnits(A)).rejects.toMatchObject({ code: 'RATE_LIMITED_SESSION' });
    } finally {
      await testDb.execute(sql`set time zone 'UTC'`);
    }
  });

  it('applies the global cap from GLOBAL_DAILY_UNITS across sessions', async () => {
    await seedRounds(testDb, A, 15);
    await seedRounds(testDb, B, GLOBAL_CAP - 16);
    await expect(checkUnits(C)).resolves.toBeUndefined();

    await seedRounds(testDb, B, 1);
    await expect(checkUnits(C)).rejects.toMatchObject({ code: 'RATE_LIMITED_GLOBAL', status: 429 });
  });

  it('runs inside the caller transaction, which then inserts the round', async () => {
    const jobId = await seedJob(testDb, A);
    await testDb.transaction(async (tx) => {
      await checkUnits(A, tx);
      await tx.insert(jobRounds).values({ jobId, sessionId: A, round: 1, kind: 'generation' });
    });
    const [{ count }] = await testDb.select({ count: sql<number>`count(*)::int` }).from(jobRounds);
    expect(count).toBe(1);
  });
});
