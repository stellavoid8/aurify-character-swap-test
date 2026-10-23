import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, providerCalls, uploads, webhookEvents } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

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

/** Runs queued after() work, including work it queues itself, concurrently within each wave. */
async function drain() {
  while (afterQueue.length > 0) {
    const tasks = afterQueue.splice(0);
    await Promise.all(tasks.map((task) => task()));
  }
}

/** Stands in for the fal queue: records each submission; the test delivers the webhooks itself. */
type Submission = { requestId: string; input: Record<string, unknown>; webhookUrl: string };
const fal = vi.hoisted(() => ({ submissions: [] as Submission[], next: 0 }));
vi.mock('@/lib/fal/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/fal/client')>();
  return {
    ...actual,
    submitToQueue: vi.fn(async ({ input, webhookUrl }: Omit<Submission, 'requestId'>) => {
      const requestId = `req-${++fal.next}`;
      fal.submissions.push({ requestId, input, webhookUrl });
      return { requestId };
    }),
  };
});

const rounds = vi.hoisted(() => ({ generated: [] as string[] }));
vi.mock('@/lib/pipeline/orchestrator', async (orig) => {
  const actual = await orig<typeof import('@/lib/pipeline/orchestrator')>();
  return {
    ...actual,
    onRoundGenerated: vi.fn(async (roundId: string) => {
      rounds.generated.push(roundId);
      return actual.onRoundGenerated(roundId);
    }),
  };
});

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

const { POST: createJobRoute } = await import('@/app/api/jobs/route');
const { POST: webhookRoute } = await import('@/app/api/webhooks/fal/route');
const { signSession, newSessionPayload } = await import('@/lib/session');
const { putObject } = await import('@/lib/storage');
const { env } = await import('@/lib/env');
const { mockWebhookBody } = await import('@/lib/fal/mock');
const { webhookUrlFor } = await import('@/lib/webhook-token');
const { PRIMARY_GENERATOR } = await import('@/lib/fal/models');
const { FAL_PRICES } = await import('@/lib/fal/pricing');
const primaryCost = FAL_PRICES[PRIMARY_GENERATOR].perImageUsdMicros;

const SID = '77777777-7777-4777-8777-777777777777';
const UPLOADS = path.join(process.cwd(), 'public', 'uploads');
const FIXTURE = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'face-one-grey.jpg'));
let templateUrl: string;

/** MOCK_FAL_FAILURE_MODE is read from the parsed env object at call time, so tests flip it there. */
function setFailureMode(mode: 'none' | 'once' | 'always') {
  (env as { MOCK_FAL_FAILURE_MODE: string }).MOCK_FAL_FAILURE_MODE = mode;
}

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
  cookieJar.set('cs_session', await signSession(newSessionPayload(SID)));
  ({ url: templateUrl } = await putObject(`sessions/${SID}/webhook-test/template.jpg`, FIXTURE, 'image/jpeg'));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(path.join(UPLOADS, 'sessions', SID), { recursive: true, force: true });
  rmSync(path.join(UPLOADS, 'results'), { recursive: true, force: true });
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads, provider_calls, webhook_events cascade`);
  afterQueue.length = 0;
  fal.submissions.length = 0;
  rounds.generated.length = 0;
  setFailureMode('none');
});

/** Creates a job through POST /api/jobs and runs its analysis, leaving 3 submitted candidates. */
async function startJob(): Promise<string> {
  const [template] = await testDb
    .insert(uploads)
    .values({ sessionId: SID, kind: 'template', status: 'ok', rawUrl: templateUrl, url: templateUrl, width: 10, height: 10, bytes: 1 })
    .returning();
  const [user] = await testDb
    .insert(uploads)
    .values({ sessionId: SID, kind: 'user', status: 'ok', rawUrl: templateUrl, url: templateUrl, width: 10, height: 10, bytes: 1 })
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
  expect(fal.submissions).toHaveLength(3);
  return data.jobId;
}

const callWebhook = (url: string, body: unknown) =>
  webhookRoute(
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );

const attemptOf = (url: string) => Number(new URL(url).searchParams.get('a'));

/** What fal would POST for a submission, per MOCK_FAL_FAILURE_MODE. */
const bodyFor = (s: Submission) => mockWebhookBody(s.requestId, s.input, attemptOf(s.webhookUrl));

/** Delivers every outstanding submission's webhook concurrently, then the work they queue, until fal is idle. */
async function deliverAll() {
  let delivered = 0;
  while (delivered < fal.submissions.length) {
    const batch = fal.submissions.slice(delivered);
    delivered = fal.submissions.length;
    const responses = await Promise.all(batch.map((s) => callWebhook(s.webhookUrl, bodyFor(s))));
    expect(responses.map((r) => r.status)).toEqual(batch.map(() => 200));
    await drain();
  }
}

const jobRow = async (id: string) => (await testDb.select().from(jobs).where(eq(jobs.id, id)))[0];
const candidateRows = (jobId: string) => testDb.select().from(candidates).where(eq(candidates.jobId, jobId)).orderBy(candidates.id);

describe('POST /api/webhooks/fal', () => {
  it('fans in three concurrent OK webhooks: one ranking transition, 3 stored results', async () => {
    const jobId = await startJob();
    await deliverAll();

    expect(rounds.generated).toHaveLength(1);
    const rows = await candidateRows(jobId);
    expect(rows.map((c) => c.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    for (const c of rows) {
      expect(c.imageUrl).toBe(`http://localhost:3000/uploads/results/${jobId}/${c.id}.jpg`);
      expect(c.imageUrl).not.toBe(templateUrl);
      expect(c.costUsdMicros).toBe(primaryCost);
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
      const stored = readFileSync(path.join(UPLOADS, 'results', jobId, `${c.id}.jpg`));
      expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }

    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'succeeded', stage: 'done' });
    expect(rows.map((c) => c.id)).toContain(job.chosenCandidateId);
    const [round] = await testDb.select().from(jobRounds).where(eq(jobRounds.jobId, jobId));
    expect(round.status).toBe('succeeded');
    expect(round.stageTimings.generating?.ms).not.toBeNull();
    expect(round.stageTimings.ranking?.startedAt).toBeTruthy();

    const calls = await testDb.select().from(providerCalls).where(eq(providerCalls.stage, 'generating'));
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.provider === 'fal' && c.status === 'ok' && c.costUsdMicros === primaryCost)).toBe(true);
    const events = await testDb.select().from(webhookEvents);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.processedAt !== null)).toBe(true);
  });

  it('answers a replayed webhook with duplicate: true and changes nothing', async () => {
    const jobId = await startJob();
    const first = fal.submissions[0];
    const res = await callWebhook(first.webhookUrl, bodyFor(first));
    expect(await res.json()).toEqual({ data: { received: true } });

    // Replayed before the first delivery was processed.
    expect(await (await callWebhook(first.webhookUrl, bodyFor(first))).json()).toEqual({ data: { duplicate: true } });
    expect(afterQueue).toHaveLength(1);
    await deliverAll();

    const before = { job: await jobRow(jobId), rows: await candidateRows(jobId) };
    for (const s of fal.submissions) {
      const replay = await callWebhook(s.webhookUrl, bodyFor(s));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ data: { duplicate: true } });
    }
    expect(afterQueue).toHaveLength(0);
    expect({ job: await jobRow(jobId), rows: await candidateRows(jobId) }).toEqual(before);
    expect(rounds.generated).toHaveLength(1);
  });

  it('is 401 for a bad token, without touching the database', async () => {
    await startJob();
    const s = fal.submissions[0];
    const forged = new URL(s.webhookUrl);
    forged.searchParams.set('t', 'A'.repeat(43));
    const res = await callWebhook(forged.toString(), bodyFor(s));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'WEBHOOK_UNAUTHORIZED' } });

    const otherAttempt = new URL(s.webhookUrl);
    otherAttempt.searchParams.set('a', '2');
    expect((await callWebhook(otherAttempt.toString(), bodyFor(s))).status).toBe(401);
    expect(await testDb.select().from(webhookEvents)).toHaveLength(0);
    expect(afterQueue).toHaveLength(0);
  });

  it('is 400 for a malformed body with a valid token', async () => {
    await startJob();
    const res = await callWebhook(fal.submissions[0].webhookUrl, { status: 'DONE' });
    expect(res.status).toBe(400);
    expect(await testDb.select().from(webhookEvents)).toHaveLength(0);
  });

  it('MOCK_FAL_FAILURE_MODE=once: each candidate fails once, is resubmitted with a new seed, then succeeds', async () => {
    setFailureMode('once');
    const jobId = await startJob();
    const firstSeeds = new Map((await candidateRows(jobId)).map((c) => [c.id, c.seed]));
    await deliverAll();

    expect(fal.submissions).toHaveLength(6);
    expect(fal.submissions.slice(3).every((s) => attemptOf(s.webhookUrl) === 2)).toBe(true);
    // The retry is built from the same prompt and photos, only the seed changes.
    expect(fal.submissions[3].input).toMatchObject({ prompt: fal.submissions[0].input.prompt, image_urls: fal.submissions[0].input.image_urls });

    const rows = await candidateRows(jobId);
    for (const c of rows) {
      expect(c).toMatchObject({ status: 'succeeded', attempt: 2 });
      expect(c.seed).not.toBe(firstSeeds.get(c.id));
      expect(fal.submissions.find((s) => s.requestId === c.falRequestId)?.input.seed).toBe(c.seed);
    }
    expect(await jobRow(jobId)).toMatchObject({ status: 'succeeded', stage: 'done' });
    expect(rounds.generated).toHaveLength(1);

    const calls = await testDb.select().from(providerCalls).where(eq(providerCalls.stage, 'generating'));
    expect(calls.filter((c) => c.status === 'error')).toHaveLength(3);
    expect(calls.filter((c) => c.status === 'ok')).toHaveLength(3);
  });

  it('MOCK_FAL_FAILURE_MODE=always: the job fails with GENERATION_FAILED after one retry each', async () => {
    setFailureMode('always');
    const jobId = await startJob();
    await deliverAll();

    expect(fal.submissions).toHaveLength(6);
    const rows = await candidateRows(jobId);
    expect(rows.every((c) => c.status === 'failed' && c.attempt === 2 && c.errorCode === 'GENERATION_FAILED')).toBe(true);
    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', stage: 'done', errorCode: 'GENERATION_FAILED' });
    const [round] = await testDb.select().from(jobRounds).where(eq(jobRounds.jobId, jobId));
    expect(round.status).toBe('failed');
    expect(rounds.generated).toHaveLength(0);
  });

  it('does not retry a content refusal, and fails the job with CONTENT_BLOCKED', async () => {
    const jobId = await startJob();
    await Promise.all(
      fal.submissions.map((s) =>
        callWebhook(s.webhookUrl, {
          request_id: s.requestId,
          status: 'ERROR',
          error: 'Unprocessable Entity',
          payload: { detail: [{ type: 'content_policy_violation', msg: 'flagged' }] },
        }),
      ),
    );
    await drain();

    expect(fal.submissions).toHaveLength(3);
    expect((await candidateRows(jobId)).every((c) => c.status === 'failed' && c.errorCode === 'CONTENT_BLOCKED')).toBe(true);
    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', errorCode: 'CONTENT_BLOCKED' });
  });

  it('ignores a webhook for attempt 1 after the retry moved the candidate to attempt 2', async () => {
    setFailureMode('once');
    const jobId = await startJob();
    const first = fal.submissions[0];
    await callWebhook(first.webhookUrl, bodyFor(first));
    await drain();

    const [moved] = await testDb.select().from(candidates).where(eq(candidates.falRequestId, fal.submissions[3].requestId));
    expect(moved).toMatchObject({ attempt: 2, status: 'pending' });

    // A validly signed attempt-1 URL delivering a late success under a fresh request id.
    const late = await callWebhook(webhookUrlFor(moved.id, 1), {
      request_id: 'req-late',
      status: 'OK',
      payload: { images: [{ url: templateUrl }] },
    });
    expect(await late.json()).toEqual({ data: { received: true } });
    await drain();

    const [unchanged] = await testDb.select().from(candidates).where(eq(candidates.id, moved.id));
    expect(unchanged).toEqual(moved);
    expect(await jobRow(jobId)).toMatchObject({ status: 'running', stage: 'generating' });
  });

  it('stores a result that arrives after the job timed out, without changing the job', async () => {
    const jobId = await startJob();
    await testDb.update(jobs).set({ status: 'timed_out', stage: 'done', errorCode: 'JOB_TIMED_OUT' }).where(eq(jobs.id, jobId));
    await deliverAll();

    const rows = await candidateRows(jobId);
    expect(rows.every((c) => c.status === 'succeeded' && c.imageUrl?.includes('/uploads/results/'))).toBe(true);
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'timed_out', stage: 'done', chosenCandidateId: null });
    expect(job.notices).toEqual([{ code: 'LATE_RESULTS_ADDED' }]);
    expect(rounds.generated).toHaveLength(0);
  });
});
