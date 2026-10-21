import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobRounds, providerCalls } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedRounds } from './helpers/seed';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

const SID = '00000000-0000-4000-8000-0000000000aa';

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

const { markStageEnd, markStageStart, recordCall, timeStage } = await import('@/lib/telemetry');

async function timings(roundId: string) {
  const [row] = await testDb.select().from(jobRounds).where(eq(jobRounds.id, roundId));
  return row.stageTimings;
}

describe('recordCall', () => {
  it('writes a provider_calls row with integer micros', async () => {
    await recordCall({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      stage: 'analyze',
      status: 'ok',
      latencyMs: 812.6,
      costUsdMicros: 14_000,
      meta: { inputTokens: 1000 },
    });
    const [row] = await testDb.select().from(providerCalls);
    expect(row).toMatchObject({ provider: 'anthropic', latencyMs: 813, costUsdMicros: 14_000, jobId: null });
    expect(row.meta).toEqual({ inputTokens: 1000 });
  });

  it('does not throw when the insert fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordCall({
        jobId: '00000000-0000-4000-8000-000000000999', // no such job: FK violation
        provider: 'fal',
        model: 'x',
        stage: 'generate',
        status: 'error',
        latencyMs: 1,
        costUsdMicros: 0,
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('stage timings', () => {
  it('timeStage records start, end and duration', async () => {
    const [roundId] = await seedRounds(testDb, SID, 1);
    const result = await timeStage(roundId, 'analyzing', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 42;
    });
    expect(result).toBe(42);
    const stage = (await timings(roundId)).analyzing!;
    expect(new Date(stage.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(stage.startedAt).getTime());
    expect(stage.ms).toBeGreaterThanOrEqual(15);
  });

  it('records the end even when the stage throws', async () => {
    const [roundId] = await seedRounds(testDb, SID, 1);
    await expect(
      timeStage(roundId, 'ranking', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await timings(roundId)).ranking).toMatchObject({ endedAt: expect.any(String), ms: expect.any(Number) });
  });

  it('keeps other stages when stages are written separately', async () => {
    const [roundId] = await seedRounds(testDb, SID, 1);
    await markStageStart(roundId, 'generating');
    await Promise.all([markStageStart(roundId, 'ranking'), markStageEnd(roundId, 'generating')]);
    const all = await timings(roundId);
    expect(all.generating).toMatchObject({ endedAt: expect.any(String), ms: expect.any(Number) });
    expect(all.ranking).toMatchObject({ startedAt: expect.any(String), endedAt: null, ms: null });
  });

  it('leaves ms null when a stage ends without a start', async () => {
    const [roundId] = await seedRounds(testDb, SID, 1);
    await markStageEnd(roundId, 'refining');
    expect((await timings(roundId)).refining).toMatchObject({ startedAt: null, ms: null });
  });
});
