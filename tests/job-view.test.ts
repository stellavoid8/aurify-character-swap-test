import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, uploads } from '@/lib/db/schema';
import { DEFAULT_ETA_MS, ETA_MIN_SAMPLES } from '@/lib/limits';
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

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
}));

vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('SESSION_SECRET', 'test-secret');
vi.stubEnv('GLOBAL_DAILY_UNITS', '1000');

const { GET } = await import('@/app/api/jobs/[id]/route');
const { signSession, newSessionPayload } = await import('@/lib/session');
const { computeEtaMs } = await import('@/server/stats/queries');

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads cascade`);
});

async function signInAs(sid: string) {
  cookieJar.set('cs_session', await signSession(newSessionPayload(sid)));
}

const getView = (id: string) => GET(new Request(`http://localhost:3000/api/jobs/${id}`), { params: Promise.resolve({ id }) });

/** A running job for SID_A with a template, two user photos (the second is the reference) and one round. */
async function seedRunningJob() {
  const [template, photo1, photo2] = await testDb
    .insert(uploads)
    .values([
      { sessionId: SID_A, kind: 'template', status: 'ok', rawUrl: 'https://e.test/t', url: 'https://e.test/t.jpg', width: 800, height: 600, bytes: 1, faces: [{ box: [0.1, 0.2, 0.3, 0.4], score: 0.9, landmarks: [] }], subjectFaceIndex: 0 },
      { sessionId: SID_A, kind: 'user', status: 'ok', rawUrl: 'https://e.test/u1', url: 'https://e.test/u1.jpg', width: 1, height: 1, bytes: 1 },
      { sessionId: SID_A, kind: 'user', status: 'ok', rawUrl: 'https://e.test/u2', url: 'https://e.test/u2.jpg', width: 1, height: 1, bytes: 1 },
    ])
    .returning();
  const [job] = await testDb
    .insert(jobs)
    .values({
      sessionId: SID_A,
      status: 'running',
      stage: 'generating',
      templateUploadId: template.id,
      userUploadIds: [photo1.id, photo2.id],
      referenceUploadId: photo2.id,
      currentRound: 1,
      flags: { crossGender: false, crossAge: false, multiPerson: true, subjectLabel: 'the woman on the left' },
      notices: [{ code: 'TEMPLATE_MULTIPLE_PEOPLE', params: { count: 2, subjectLabel: 'the woman on the left' } }],
      deadlineAt: sql`now() + interval '5 minutes'`,
    })
    .returning();
  const [round] = await testDb
    .insert(jobRounds)
    .values({ jobId: job.id, sessionId: SID_A, round: 1, kind: 'generation', startedAt: sql`now() - interval '42 seconds'` })
    .returning();
  await testDb.insert(candidates).values({ jobId: job.id, roundId: round.id, kind: 'generation', model: 'test/model', seed: 1 });
  return { jobId: job.id, photo2Id: photo2.id };
}

describe('GET /api/jobs/[id]', () => {
  it("returns the owner's job view, uncached", async () => {
    const { jobId, photo2Id } = await seedRunningJob();
    await signInAs(SID_A);
    const res = await getView(jobId);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = await res.json();
    expect(data).toMatchObject({
      id: jobId,
      status: 'running',
      stage: 'generating',
      round: 1,
      etaMs: DEFAULT_ETA_MS,
      error: null,
      template: { url: 'https://e.test/t.jpg', width: 800, height: 600, subjectBox: [0.1, 0.2, 0.3, 0.4], subjectLabel: 'the woman on the left' },
      notices: [{ code: 'TEMPLATE_MULTIPLE_PEOPLE', message: "Your template has 2 people. We'll swap the woman on the left." }],
      chosenCandidateId: null,
      canRetry: false,
      canRefine: false,
    });
    expect(data.userPhotos.map((p: { isReference: boolean }) => p.isReference)).toEqual([false, true]);
    expect(data.userPhotos[1].id).toBe(photo2Id);
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0]).toMatchObject({ round: 1, status: 'pending', imageUrl: null, rank: null });
    expect(data.elapsedMs).toBeGreaterThanOrEqual(42_000);
    expect(data.unitsLeftToday).toBeGreaterThan(0);
  });

  it("is 404 JOB_NOT_FOUND for another session's job", async () => {
    const { jobId } = await seedRunningJob();
    await signInAs(SID_B);
    const res = await getView(jobId);

    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
  });

  it('is 404 for a malformed id and 401 without a session', async () => {
    await signInAs(SID_A);
    expect((await getView('not-a-uuid')).status).toBe(404);
    cookieJar.clear();
    expect((await getView('00000000-0000-4000-8000-000000000000')).status).toBe(401);
  });
});

describe('computeEtaMs', () => {
  /** A finished generation round that took `seconds`, started `daysAgo` days ago, ranked by `scorer`. */
  async function finishedRound(seconds: number, { daysAgo = 0, scorer = 'onnx' as 'onnx' | 'mock' } = {}) {
    const jobId = await seedJob(testDb, SID_A);
    const start = sql`now() - make_interval(days => ${daysAgo}) - interval '1 hour'`;
    const [round] = await testDb
      .insert(jobRounds)
      .values({
        jobId,
        sessionId: SID_A,
        round: 1,
        kind: 'generation',
        status: 'succeeded',
        startedAt: start,
        finishedAt: sql`${start} + make_interval(secs => ${seconds})`,
      })
      .returning();
    await testDb
      .insert(candidates)
      .values({ jobId, roundId: round.id, kind: 'generation', model: 'm', seed: 1, status: 'succeeded', scorer });
  }

  it(`uses the default below ${ETA_MIN_SAMPLES} real rounds`, async () => {
    for (const s of [60, 70, 80, 90]) await finishedRound(s);
    expect(await computeEtaMs()).toBe(DEFAULT_ETA_MS);
  });

  it('uses the p50 of recent real rounds once there are enough, ignoring mock-scored and old ones', async () => {
    for (const s of [60, 70, 80, 90, 100]) await finishedRound(s);
    await finishedRound(1000, { scorer: 'mock' });
    await finishedRound(1000, { daysAgo: 8 });
    expect(await computeEtaMs()).toBe(80_000);
  });
});
