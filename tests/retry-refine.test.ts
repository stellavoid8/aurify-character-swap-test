import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, providerCalls, uploads } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedRounds } from './helpers/seed';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath, revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
}));

// after() callbacks are queued here and run by drain(), so each test controls when background work happens.
const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<object>()),
  after: (task: () => unknown) => afterQueue.push(task),
}));

async function drain() {
  while (afterQueue.length > 0) {
    const tasks = afterQueue.splice(0);
    await Promise.all(tasks.map((task) => task()));
  }
}

/** Stands in for the fal queue: records each submission; the test delivers the webhooks itself. */
type Submission = { model: string; requestId: string; input: Record<string, unknown>; webhookUrl: string };
const fal = vi.hoisted(() => ({ submissions: [] as Submission[], next: 0 }));
vi.mock('@/lib/fal/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/fal/client')>();
  return {
    ...actual,
    submitToQueue: vi.fn(async ({ model, input, webhookUrl }: Omit<Submission, 'requestId'>) => {
      const requestId = `req-${++fal.next}`;
      fal.submissions.push({ model, requestId, input, webhookUrl });
      return { requestId };
    }),
  };
});

const analyzeJob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pipeline/analyze', async (orig) => {
  const actual = await orig<typeof import('@/lib/pipeline/analyze')>();
  analyzeJob.mockImplementation(actual.analyzeJob);
  return { ...actual, analyzeJob };
});

vi.mock('@/lib/limits', async (orig) => ({
  ...(await orig<typeof import('@/lib/limits')>()),
  // Production makes one image per round; three exercise the fan-in of concurrent webhooks.
  CANDIDATES_PER_ROUND: 3,
}));
vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('APP_URL', 'http://localhost:3000');
vi.stubEnv('SESSION_SECRET', 'test-secret');
vi.stubEnv('WEBHOOK_SECRET', 'test-webhook-secret');
vi.stubEnv('FAL_KEY', '');
vi.stubEnv('ANTHROPIC_API_KEY', '');
vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
vi.stubEnv('FACE_ENGINE', 'mock');
vi.stubEnv('GLOBAL_DAILY_UNITS', '1000');
vi.stubEnv('MOCK_FAL_FAILURE_MODE', 'none');

const actions = await import('@/server/jobs/actions');
const { chooseCandidate, retryJob, refineCandidate } = actions;
const { POST: createJobRoute } = await import('@/app/api/jobs/route');
const { POST: webhookRoute } = await import('@/app/api/webhooks/fal/route');
const { signSession, newSessionPayload } = await import('@/lib/session');
const { putObject } = await import('@/lib/storage');
const { env } = await import('@/lib/env');
const { mockWebhookBody } = await import('@/lib/fal/mock');
const { REFINE_MODEL } = await import('@/lib/fal/models');
const { faceEngine } = await import('@/lib/face');
const { enforceTimeout } = await import('@/lib/pipeline/timeout');
const { JOB_TIMEOUT_MS, MAX_ROUNDS_PER_JOB, SESSION_DAILY_UNITS } = await import('@/lib/limits');

const SID_A = '55555555-5555-4555-8555-555555555555';
const SID_B = '66666666-6666-4666-8666-666666666666';
const UPLOADS = path.join(process.cwd(), 'public', 'uploads');
const FIXTURE = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'face-one-grey.jpg'));
let photoUrl: string;
let embedding: number[];

function setFailureMode(mode: 'none' | 'once' | 'always') {
  (env as { MOCK_FAL_FAILURE_MODE: string }).MOCK_FAL_FAILURE_MODE = mode;
}

async function signInAs(sid: string) {
  cookieJar.set('cs_session', await signSession(newSessionPayload(sid)));
}

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
  ({ url: photoUrl } = await putObject(`sessions/${SID_A}/retry-refine-test/photo.jpg`, FIXTURE, 'image/jpeg'));
  // The user's photo carries a real (mock-engine) embedding, so results get a likeness score.
  const { faces } = await faceEngine.analyzeImage(FIXTURE);
  embedding = await faceEngine.embedFace(FIXTURE, faces[0]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(path.join(UPLOADS, 'sessions', SID_A), { recursive: true, force: true });
  rmSync(path.join(UPLOADS, 'results'), { recursive: true, force: true });
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads, provider_calls, webhook_events cascade`);
  afterQueue.length = 0;
  fal.submissions.length = 0;
  revalidatePath.mockClear();
  analyzeJob.mockClear();
  setFailureMode('none');
  await signInAs(SID_A);
});

const callWebhook = (url: string, body: unknown) =>
  webhookRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

const attemptOf = (url: string) => Number(new URL(url).searchParams.get('a'));

/** Delivers every outstanding submission's webhook, then the work they queue, until fal is idle. */
async function deliverAll() {
  let delivered = 0;
  while (delivered < fal.submissions.length) {
    const batch = fal.submissions.slice(delivered);
    delivered = fal.submissions.length;
    await Promise.all(batch.map((s) => callWebhook(s.webhookUrl, mockWebhookBody(s.requestId, s.input, attemptOf(s.webhookUrl)))));
    await drain();
  }
}

const jobRow = async (id: string) => (await testDb.select().from(jobs).where(eq(jobs.id, id)))[0];
const roundRows = (jobId: string) => testDb.select().from(jobRounds).where(eq(jobRounds.jobId, jobId)).orderBy(jobRounds.round);
const candidateRows = (jobId: string) =>
  testDb
    .select({ c: candidates, round: jobRounds.round })
    .from(candidates)
    .innerJoin(jobRounds, eq(jobRounds.id, candidates.roundId))
    .where(eq(candidates.jobId, jobId))
    .then((rows) => rows.map(({ c, round }) => ({ ...c, round })));

/** A job of SID_A through POST /api/jobs, with round 1 generated, ranked and succeeded. */
async function finishedJob(): Promise<string> {
  const [template] = await testDb
    .insert(uploads)
    .values({ sessionId: SID_A, kind: 'template', status: 'ok', rawUrl: photoUrl, url: photoUrl, width: 10, height: 10, bytes: 1 })
    .returning();
  const [user] = await testDb
    .insert(uploads)
    .values({ sessionId: SID_A, kind: 'user', status: 'ok', rawUrl: photoUrl, url: photoUrl, width: 10, height: 10, bytes: 1, embedding })
    .returning();
  const res = await createJobRoute(
    new Request('http://localhost:3000/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateUploadId: template.id, userUploadIds: [user.id] }),
    }),
  );
  const { data } = await res.json();
  await drain();
  await deliverAll();
  expect(await jobRow(data.jobId)).toMatchObject({ status: 'succeeded', currentRound: 1 });
  fal.submissions.length = 0;
  return data.jobId;
}

describe('retryJob', () => {
  it('makes round 2 with 3 new seeds, keeps round 1, and chooses the new best', async () => {
    const jobId = await finishedJob();
    const before = await jobRow(jobId);
    const firstSeeds = new Set((await candidateRows(jobId)).map((c) => c.seed));

    const result = await retryJob({ jobId });

    expect(result).toEqual({ ok: true, data: { round: 2 } });
    expect(revalidatePath).toHaveBeenCalledWith(`/jobs/${jobId}`);
    expect(await jobRow(jobId)).toMatchObject({ status: 'running', stage: 'generating', currentRound: 2, finishedAt: null });

    await drain();
    expect(fal.submissions).toHaveLength(3);
    // The stored analysis and prompt are reused: no second analysis call.
    expect((await jobRow(jobId)).analysis).toEqual(before.analysis);
    expect(analyzeJob).toHaveBeenCalledTimes(1);

    await deliverAll();
    const rows = await candidateRows(jobId);
    const round2 = rows.filter((c) => c.round === 2);
    expect(rows.filter((c) => c.round === 1 && c.status === 'succeeded')).toHaveLength(3);
    expect(round2.every((c) => c.status === 'succeeded' && c.kind === 'generation' && !firstSeeds.has(c.seed))).toBe(true);

    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'succeeded', stage: 'done' });
    expect(round2.find((c) => c.rank === 1)?.id).toBe(job.chosenCandidateId);
    expect((await roundRows(jobId)).map((r) => [r.round, r.kind, r.status])).toEqual([
      [1, 'generation', 'succeeded'],
      [2, 'generation', 'succeeded'],
    ]);
  });

  it('restarts a timed-out job with a fresh 6-minute deadline', async () => {
    const jobId = await finishedJob();
    await testDb
      .update(jobs)
      .set({ status: 'timed_out', errorCode: 'JOB_TIMED_OUT', errorMessage: 'x', deadlineAt: sql`now() - interval '1 minute'` })
      .where(eq(jobs.id, jobId));

    expect(await retryJob({ jobId })).toMatchObject({ ok: true, data: { round: 2 } });

    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'running', errorCode: null, errorMessage: null });
    const left = job.deadlineAt!.getTime() - Date.now();
    expect(left).toBeGreaterThan(JOB_TIMEOUT_MS - 10_000);
    expect(left).toBeLessThanOrEqual(JOB_TIMEOUT_MS + 1_000);
  });

  it('is INVALID_STATE while the job is running', async () => {
    const jobId = await finishedJob();
    await retryJob({ jobId });

    expect(await retryJob({ jobId })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(await roundRows(jobId)).toHaveLength(2);
  });

  it('is RATE_LIMITED_SESSION once the job has MAX_ROUNDS_PER_JOB rounds', async () => {
    const jobId = await finishedJob();
    await testDb.update(jobs).set({ currentRound: MAX_ROUNDS_PER_JOB }).where(eq(jobs.id, jobId));

    expect(await retryJob({ jobId })).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED_SESSION' } });
  });
});

describe('refineCandidate', () => {
  it('refines the chosen version into a scored refinement candidate, then either can be kept', async () => {
    const jobId = await finishedJob();
    const job = await jobRow(jobId);
    const parent = (await candidateRows(jobId)).find((c) => c.id === job.chosenCandidateId)!;

    const result = await refineCandidate({ jobId, candidateId: parent.id });

    expect(result).toMatchObject({ ok: true, data: { round: 2 } });
    expect(await jobRow(jobId)).toMatchObject({ status: 'running', stage: 'refining', currentRound: 2 });
    const [refined] = (await candidateRows(jobId)).filter((c) => c.kind === 'refinement');
    expect(refined).toMatchObject({ parentCandidateId: parent.id, model: REFINE_MODEL, status: 'pending', round: 2 });

    await drain();
    expect(fal.submissions).toHaveLength(1);
    expect(fal.submissions[0]).toMatchObject({
      model: REFINE_MODEL,
      input: { base_image_url: parent.imageUrl, swap_image_url: photoUrl },
    });

    await deliverAll();
    const done = (await candidateRows(jobId)).find((c) => c.id === refined.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.identityScore).toEqual(expect.any(Number));
    expect(parent.identityScore).toEqual(expect.any(Number));
    expect(done).toMatchObject({ scorer: 'mock', rank: null });

    const after = await jobRow(jobId);
    expect(after).toMatchObject({ status: 'succeeded', stage: 'done', chosenCandidateId: parent.id, notices: [] });
    expect((await roundRows(jobId))[1]).toMatchObject({ kind: 'refinement', status: 'succeeded' });
    expect((await roundRows(jobId))[1].stageTimings.refining?.ms).not.toBeNull();
    const calls = await testDb.select().from(providerCalls).where(and(eq(providerCalls.stage, 'refining'), eq(providerCalls.provider, 'fal')));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'ok', model: REFINE_MODEL, candidateId: refined.id });

    // Keep the fixed face, then change back: both persist.
    expect(await chooseCandidate({ jobId, candidateId: refined.id })).toMatchObject({ ok: true });
    expect((await jobRow(jobId)).chosenCandidateId).toBe(refined.id);
    expect(await chooseCandidate({ jobId, candidateId: parent.id })).toMatchObject({ ok: true });
    expect((await jobRow(jobId)).chosenCandidateId).toBe(parent.id);
  });

  it('a failed refinement retries once, then leaves the job succeeded with the original chosen', async () => {
    const jobId = await finishedJob();
    const chosen = (await jobRow(jobId)).chosenCandidateId!;
    setFailureMode('always');

    await refineCandidate({ jobId, candidateId: chosen });
    await drain();
    await deliverAll();

    expect(fal.submissions).toHaveLength(2);
    expect(fal.submissions[1].input).toEqual(fal.submissions[0].input);
    const [refined] = (await candidateRows(jobId)).filter((c) => c.kind === 'refinement');
    expect(refined).toMatchObject({ status: 'failed', attempt: 2, errorCode: 'REFINEMENT_FAILED' });
    expect(await jobRow(jobId)).toMatchObject({
      status: 'succeeded',
      stage: 'done',
      chosenCandidateId: chosen,
      errorCode: null,
      notices: [{ code: 'REFINEMENT_FAILED' }],
    });
    expect((await roundRows(jobId))[1]).toMatchObject({ kind: 'refinement', status: 'failed' });

    // The notice is about that attempt only; the next round clears it.
    setFailureMode('none');
    await retryJob({ jobId });
    expect((await jobRow(jobId)).notices).toEqual([]);
  });

  it('a refinement past its deadline is a failed refinement, not a timed-out job', async () => {
    const jobId = await finishedJob();
    const chosen = (await jobRow(jobId)).chosenCandidateId!;
    await refineCandidate({ jobId, candidateId: chosen });
    await testDb.update(jobs).set({ deadlineAt: sql`now() - interval '1 second'` }).where(eq(jobs.id, jobId));

    const job = await enforceTimeout(await jobRow(jobId));

    expect(job).toMatchObject({ status: 'succeeded', stage: 'done', chosenCandidateId: chosen, errorCode: null });
    expect(job.notices).toEqual([{ code: 'REFINEMENT_FAILED' }]);
    expect((await roundRows(jobId))[1].status).toBe('timed_out');

    // Its result arriving late changes nothing.
    await drain();
    await deliverAll();
    expect(await jobRow(jobId)).toMatchObject({ status: 'succeeded', chosenCandidateId: chosen, notices: [{ code: 'REFINEMENT_FAILED' }] });
  });

  it('is INVALID_STATE for a failed candidate or while the job is running', async () => {
    const jobId = await finishedJob();
    const [any] = await candidateRows(jobId);
    await testDb.update(candidates).set({ status: 'failed' }).where(eq(candidates.id, any.id));
    expect(await refineCandidate({ jobId, candidateId: any.id })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });

    const chosen = (await jobRow(jobId)).chosenCandidateId!;
    await retryJob({ jobId });
    expect(await refineCandidate({ jobId, candidateId: chosen })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
  });
});

describe('daily units and ownership', () => {
  it('Try again and Fix the face each take a unit; the 21st of the day is RATE_LIMITED_SESSION', async () => {
    const jobId = await finishedJob();
    const chosen = (await jobRow(jobId)).chosenCandidateId!;
    // The job's round 1 is unit 1; these bring the day to SESSION_DAILY_UNITS - 1.
    await seedRounds(testDb, SID_A, SESSION_DAILY_UNITS - 2);

    expect(await refineCandidate({ jobId, candidateId: chosen })).toMatchObject({ ok: true });
    await drain();
    await deliverAll();

    expect(await retryJob({ jobId })).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED_SESSION' } });
    expect(await refineCandidate({ jobId, candidateId: chosen })).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED_SESSION' } });
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'succeeded', currentRound: 2 });
    expect(await roundRows(jobId)).toHaveLength(2);
  });

  it("is JOB_NOT_FOUND for another session's job", async () => {
    const jobId = await finishedJob();
    const chosen = (await jobRow(jobId)).chosenCandidateId!;
    await signInAs(SID_B);

    expect(await retryJob({ jobId })).toMatchObject({ ok: false, error: { code: 'JOB_NOT_FOUND' } });
    expect(await refineCandidate({ jobId, candidateId: chosen })).toMatchObject({ ok: false, error: { code: 'JOB_NOT_FOUND' } });
    expect(await jobRow(jobId)).toMatchObject({ status: 'succeeded', currentRound: 1 });
    expect(afterQueue).toHaveLength(0);
  });

  it('is ACCESS_DENIED without a session', async () => {
    const jobId = await finishedJob();
    cookieJar.clear();

    expect(await retryJob({ jobId })).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
  });
});

describe('server/jobs/actions.ts', () => {
  it('exports only chooseCandidate, retryJob and refineCandidate, each calling requireSession()', () => {
    expect(Object.keys(actions).sort()).toEqual(['chooseCandidate', 'refineCandidate', 'retryJob']);
    const source = readFileSync(path.join(process.cwd(), 'server', 'jobs', 'actions.ts'), 'utf8');
    for (const name of Object.keys(actions)) {
      const body = source.slice(source.indexOf(`export async function ${name}(`)).split(/\nexport /)[0];
      expect(body).toContain('await requireSession()');
    }
  });
});
