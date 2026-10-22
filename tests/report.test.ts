import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates, jobRounds, jobs, providerCalls, uploads } from '@/lib/db/schema';
import type { JobFlags, StageTimings } from '@/lib/types';
import { computeMetrics, percentile, renderReport, replaceReadmeBlock, SEED_SESSION_ID } from '@/scripts/report';
import { createTestDb, type TestDb } from './helpers/db';

let testDb: TestDb;
let close: () => Promise<void>;

const SID = '88888888-8888-4888-8888-888888888888';
const T0 = new Date('2026-10-01T12:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const timing = (ms: number) => ({ startedAt: T0.toISOString(), endedAt: T0.toISOString(), ms });
const NEITHER: JobFlags = { crossGender: false, crossAge: false, multiPerson: false, subjectLabel: null };

type CandidateFixture = { identity?: number; cost?: number | null; attempt?: number; errorCode?: string; scorer?: 'onnx' | 'mock' };

/** One job with one finished round; each candidate gets a matching provider call; `analysisCost` adds an Anthropic call. */
async function job(opts: {
  sid?: string;
  flags?: JobFlags;
  seconds: number;
  stageTimings: StageTimings;
  analysisCost: number;
  cands: CandidateFixture[];
  chosen?: number;
}) {
  const sid = opts.sid ?? SID;
  const [template] = await testDb
    .insert(uploads)
    .values({ sessionId: sid, kind: 'template', rawUrl: 'x', width: 1, height: 1, bytes: 1 })
    .returning();
  const [jobRow] = await testDb
    .insert(jobs)
    .values({ sessionId: sid, status: 'succeeded', stage: 'done', templateUploadId: template.id, userUploadIds: [], flags: opts.flags ?? NEITHER })
    .returning();
  const [round] = await testDb
    .insert(jobRounds)
    .values({
      jobId: jobRow.id,
      sessionId: sid,
      round: 1,
      kind: 'generation',
      status: 'succeeded',
      stageTimings: opts.stageTimings,
      startedAt: T0,
      finishedAt: at(opts.seconds),
    })
    .returning();
  const rows = await testDb
    .insert(candidates)
    .values(
      opts.cands.map((c, i) => ({
        jobId: jobRow.id,
        roundId: round.id,
        kind: 'generation' as const,
        model: 'fal-ai/real-model',
        seed: i,
        attempt: c.attempt ?? 1,
        status: c.errorCode ? ('failed' as const) : ('succeeded' as const),
        identityScore: c.identity ?? null,
        scorer: c.scorer ?? 'onnx',
        errorCode: c.errorCode ?? null,
        costUsdMicros: c.cost ?? null,
      })),
    )
    .returning();
  await testDb.insert(providerCalls).values([
    { jobId: jobRow.id, roundId: round.id, provider: 'anthropic', model: 'claude-opus-5-5', stage: 'analyzing', status: 'ok', latencyMs: 1, costUsdMicros: opts.analysisCost },
    ...rows.map((c) => ({
      jobId: jobRow.id,
      roundId: round.id,
      candidateId: c.id,
      provider: 'fal' as const,
      model: c.model,
      stage: 'generating',
      status: 'ok' as const,
      latencyMs: 1,
      costUsdMicros: c.costUsdMicros ?? 0,
    })),
  ]);
  if (opts.chosen !== undefined) {
    const { eq } = await import('drizzle-orm');
    await testDb.update(jobs).set({ chosenCandidateId: rows[opts.chosen].id }).where(eq(jobs.id, jobRow.id));
  }
  return { job: jobRow, candidates: rows };
}

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());

  // A: neither case, 100 s round, 3 × $0.04 + $0.021 analysis = $0.141. One auto-retry.
  await job({
    seconds: 100,
    stageTimings: { analyzing: timing(10_000), generating: timing(80_000), ranking: timing(10_000) },
    analysisCost: 21_000,
    cands: [{ identity: 0.7, cost: 40_000 }, { identity: 0.6, cost: 40_000, attempt: 2 }, { identity: 0.5, cost: 40_000 }],
    chosen: 0,
  });

  // B: cross-gender, 200 s round, 2 × $0.05 + $0.03 analysis = $0.13. One content refusal. Then a Fix the face round.
  const b = await job({
    flags: { ...NEITHER, crossGender: true },
    seconds: 200,
    stageTimings: { analyzing: timing(20_000), generating: timing(160_000), ranking: timing(20_000) },
    analysisCost: 30_000,
    cands: [{ identity: 0.5, cost: 50_000 }, { identity: 0.4, cost: 50_000 }, { errorCode: 'CONTENT_BLOCKED' }],
    chosen: 0,
  });
  const [refineRound] = await testDb
    .insert(jobRounds)
    .values({ jobId: b.job.id, sessionId: SID, round: 2, kind: 'refinement', status: 'succeeded', stageTimings: { refining: timing(30_000) }, startedAt: at(300), finishedAt: at(330) })
    .returning();
  const [refined] = await testDb
    .insert(candidates)
    .values({ jobId: b.job.id, roundId: refineRound.id, kind: 'refinement', parentCandidateId: b.candidates[0].id, model: 'fal-ai/refiner', seed: 9, status: 'succeeded', identityScore: 0.6, scorer: 'onnx', costUsdMicros: 60_000 })
    .returning();
  await testDb.insert(providerCalls).values({ jobId: b.job.id, roundId: refineRound.id, candidateId: refined.id, provider: 'fal', model: 'fal-ai/refiner', stage: 'refining', status: 'ok', latencyMs: 1, costUsdMicros: 60_000 });

  // Excluded: a mock-scored job and a seed-session job, both with outlying numbers.
  const outlier = {
    seconds: 1000,
    stageTimings: { analyzing: timing(999_000), generating: timing(999_000), ranking: timing(999_000) },
    analysisCost: 9_000_000,
    cands: [{ identity: 0.01, cost: 9_000_000, errorCode: 'GENERATION_FAILED' }],
    chosen: 0,
  };
  await job({ ...outlier, cands: [{ ...outlier.cands[0], scorer: 'mock' }] });
  await job({ ...outlier, sid: SEED_SESSION_ID });
});

afterAll(async () => {
  await close();
});

describe('percentile', () => {
  it('interpolates between ranks like percentile_cont', () => {
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('computeMetrics', () => {
  it('matches hand-computed values and leaves out mock and seed rows', async () => {
    const m = await computeMetrics(testDb, { budgetUsd: 10 });

    expect(m.jobs).toBe(2);
    expect(m.stages.analyzing).toEqual({ count: 2, p50: 15_000, p95: 19_500 });
    expect(m.stages.generating).toEqual({ count: 2, p50: 120_000, p95: 156_000 });
    expect(m.stages.refining).toEqual({ count: 1, p50: 30_000, p95: 30_000 });
    expect(m.endToEndMs).toEqual({ count: 2, p50: 150_000, p95: 195_000 });

    // (3 × 40 000 + 2 × 50 000) / 5
    expect(m.costPerCandidate).toMatchObject({ count: 5, mean: 44_000 });
    // (141 000 + 130 000) / 2
    expect(m.costPerRound).toMatchObject({ count: 2, mean: 135_500 });
    expect(m.costPerRefinement).toMatchObject({ count: 1, mean: 60_000 });
    // floor($10 / $0.1355)
    expect(m.suggestedDailyUnits).toBe(73);

    expect(m.identityByCase.neither).toMatchObject({ count: 1, mean: 0.7 });
    expect(m.identityByCase.crossGender.count).toBe(1);
    expect(m.identityByCase.crossGender.mean).toBeCloseTo(0.5);
    expect(m.identityByCase.crossAge).toEqual({ count: 0, mean: null, median: null });
    expect(m.refinement.pairs).toBe(1);
    expect(m.refinement.improved).toBe(1);
    expect(m.refinement.before).toBeCloseTo(0.5);
    expect(m.refinement.after).toBeCloseTo(0.6);

    expect(m.failures).toEqual([{ code: 'CONTENT_BLOCKED', jobs: 0, candidates: 1 }]);
    expect(m.autoRetries).toBe(1);
    expect(m.contentBlockedByCase).toEqual({ crossGender: 1, crossAge: 0, neither: 0 });
  });

  it('renders every section, with formatted money', async () => {
    const md = renderReport(await computeMetrics(testDb, { budgetUsd: 10 }));
    for (const heading of ['### Time per stage', '### Cost', '### Likeness of the chosen picture', '### Failures']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('| Generation round (all provider calls, incl. Anthropic) | 2 | $0.136 |');
    expect(md).toContain('**73**');
    expect(md).toContain('fal billed total for the window: ____');
  });

  it('renders an empty database without crashing', async () => {
    const empty = await createTestDb();
    const md = renderReport(await computeMetrics(empty.db));
    await empty.close();
    expect(md).toContain('No real jobs yet');
    expect(md).toContain('No failures recorded.');
  });
});

describe('replaceReadmeBlock', () => {
  it('replaces only the text between the markers', () => {
    const readme = 'intro\n<!-- METRICS:START -->\nold\n<!-- METRICS:END -->\noutro\n';
    expect(replaceReadmeBlock(readme, 'new\n')).toBe('intro\n<!-- METRICS:START -->\nnew\n<!-- METRICS:END -->\noutro\n');
    expect(replaceReadmeBlock('no markers', 'new')).toBeNull();
  });
});
