import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, uploads } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedRounds } from './helpers/seed';

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

// after() callbacks are queued here and run by drain(), so the test sees the response before the work.
const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<object>()),
  after: (task: () => unknown) => afterQueue.push(task),
}));

/** Runs the after() work queued so far. Tasks it queues itself (mock fal webhook delivery) are dropped. */
async function drain() {
  const tasks = afterQueue.splice(0);
  await Promise.all(tasks.map((task) => task()));
  afterQueue.length = 0;
}

const submitSpy = vi.hoisted(() => ({ fn: null as null | ReturnType<typeof vi.fn> }));
vi.mock('@/lib/fal/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/fal/client')>();
  submitSpy.fn = vi.fn(actual.submitToQueue);
  return { ...actual, submitToQueue: submitSpy.fn };
});

vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('SESSION_SECRET', 'test-secret');
vi.stubEnv('FAL_KEY', '');
vi.stubEnv('ANTHROPIC_API_KEY', '');
vi.stubEnv('GLOBAL_DAILY_UNITS', '1000');

const { POST } = await import('@/app/api/jobs/route');
const { signSession, newSessionPayload } = await import('@/lib/session');
const { AppError } = await import('@/lib/errors');

const SID = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads, provider_calls cascade`);
  afterQueue.length = 0;
  submitSpy.fn!.mockClear();
  await signIn(SID);
});

async function signIn(sid: string) {
  cookieJar.set('cs_session', await signSession(newSessionPayload(sid)));
}

async function seedUploads(sid: string, { userCount = 2, templateQuery = '' } = {}) {
  const [template] = await testDb
    .insert(uploads)
    .values({
      sessionId: sid,
      kind: 'template',
      status: 'ok',
      rawUrl: 'https://example.test/t-raw.jpg',
      url: `https://example.test/t.jpg${templateQuery}`,
      width: 1000,
      height: 1000,
      bytes: 1,
    })
    .returning();
  const users = await testDb
    .insert(uploads)
    .values(
      Array.from({ length: userCount }, (_, i) => ({
        sessionId: sid,
        kind: 'user' as const,
        status: 'ok' as const,
        rawUrl: `https://example.test/u${i}-raw.jpg`,
        url: `https://example.test/u${i}.jpg`,
        width: 1000,
        height: 1000,
        bytes: 1,
        qualityScore: 0.5 + i / 10,
      })),
    )
    .returning();
  return { templateUploadId: template.id, userUploadIds: users.map((u) => u.id) };
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost:3000/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/jobs', () => {
  it('returns 201 before analysis, then analyzes and submits 3 seeded candidates', async () => {
    const body = await seedUploads(SID);
    const started = performance.now();
    const res = await post(body);
    const ms = performance.now() - started;
    console.info('[test] POST /api/jobs answered in', Math.round(ms), 'ms');
    expect(res.status).toBe(201);
    expect(ms).toBeLessThan(1000);
    const { data } = await res.json();

    let [job] = await testDb.select().from(jobs).where(eq(jobs.id, data.jobId));
    expect(job).toMatchObject({ sessionId: SID, status: 'running', stage: 'analyzing', currentRound: 1, analysis: null });
    expect(job.deadlineAt!.getTime() - job.createdAt.getTime()).toBeCloseTo(6 * 60_000, -3);
    const [round] = await testDb.select().from(jobRounds).where(eq(jobRounds.jobId, job.id));
    expect(round).toMatchObject({ round: 1, kind: 'generation', status: 'running' });
    expect(round.stageTimings.analyzing?.startedAt).toBeTruthy();

    await drain();

    [job] = await testDb.select().from(jobs).where(eq(jobs.id, data.jobId));
    expect(job.stage).toBe('generating');
    expect(job.analysis).not.toBeNull();
    expect(job.prompt).toContain('Image 1 is the scene');
    // The higher-quality photo becomes the reference.
    expect(job.referenceUploadId).toBe(body.userUploadIds[1]);
    expect(job.flags).toEqual({ crossGender: false, crossAge: false, multiPerson: false, subjectLabel: 'the person in the centre' });

    const rows = await testDb.select().from(candidates).where(eq(candidates.jobId, job.id));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((c) => c.seed)).size).toBe(3);
    expect(new Set(rows.map((c) => c.falRequestId)).size).toBe(3);
    expect(rows.every((c) => c.status === 'pending' && c.kind === 'generation' && c.attempt === 1)).toBe(true);

    const { input, webhookUrl } = submitSpy.fn!.mock.calls[0][0];
    expect(input.image_urls).toEqual(['https://example.test/t.jpg', 'https://example.test/u1.jpg', 'https://example.test/u0.jpg']);
    expect(webhookUrl).toMatch(/\/api\/webhooks\/fal\?cid=[0-9a-f-]{36}&a=1&t=/);

    const [timed] = await testDb.select().from(jobRounds).where(eq(jobRounds.jobId, job.id));
    expect(timed.stageTimings.analyzing?.endedAt).toBeTruthy();
    expect(timed.stageTimings.generating?.startedAt).toBeTruthy();
  });

  it('flags a cross-gender template and adds the body clause', async () => {
    const res = await post(await seedUploads(SID, { templateQuery: '?mock=crossGender' }));
    const { data } = await res.json();
    await drain();
    const [job] = await testDb.select().from(jobs).where(eq(jobs.id, data.jobId));
    expect(job.flags.crossGender).toBe(true);
    expect(job.prompt).toContain("Do not transfer the original subject's body");
  });

  it('fails the job with the submit error when every candidate is refused', async () => {
    submitSpy.fn!.mockRejectedValue(new AppError('CONTENT_BLOCKED'));
    try {
      const { data } = await (await post(await seedUploads(SID))).json();
      await drain();
      const [job] = await testDb.select().from(jobs).where(eq(jobs.id, data.jobId));
      expect(job).toMatchObject({ status: 'failed', stage: 'done', errorCode: 'CONTENT_BLOCKED' });
      expect(job.finishedAt).not.toBeNull();
      const [round] = await testDb.select().from(jobRounds).where(eq(jobRounds.jobId, job.id));
      expect(round.status).toBe('failed');
      const rows = await testDb.select().from(candidates).where(eq(candidates.jobId, job.id));
      expect(rows.every((c) => c.status === 'failed' && c.errorCode === 'CONTENT_BLOCKED')).toBe(true);
    } finally {
      submitSpy.fn!.mockReset();
      submitSpy.fn!.mockImplementation((await vi.importActual<typeof import('@/lib/fal/client')>('@/lib/fal/client')).submitToQueue);
    }
  });

  it('keeps the job running when only some submissions fail', async () => {
    submitSpy.fn!.mockRejectedValueOnce(new AppError('GENERATION_FAILED'));
    const { data } = await (await post(await seedUploads(SID))).json();
    await drain();
    const [job] = await testDb.select().from(jobs).where(eq(jobs.id, data.jobId));
    expect(job).toMatchObject({ status: 'running', stage: 'generating' });
    const rows = await testDb.select().from(candidates).where(eq(candidates.jobId, job.id));
    expect(rows.filter((c) => c.status === 'failed')).toHaveLength(1);
  });

  it('returns 429 for the 21st round of the UTC day, while another session still works', async () => {
    await seedRounds(testDb, SID, 20);
    const res = await post(await seedUploads(SID));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: 'RATE_LIMITED_SESSION', message: "You've reached today's limit of 20 pictures." },
    });
    expect(afterQueue).toHaveLength(0);

    await signIn(OTHER);
    expect((await post(await seedUploads(OTHER))).status).toBe(201);
  });

  it("is 404 for another session's uploads", async () => {
    const theirs = await seedUploads(OTHER);
    const res = await post(theirs);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'UPLOAD_NOT_FOUND' } });
  });

  it('is 400 for 5 user photos, swapped kinds or a rejected photo', async () => {
    const body = await seedUploads(SID, { userCount: 5 });
    expect((await post(body)).status).toBe(400);

    const swapped = { templateUploadId: body.userUploadIds[0], userUploadIds: [body.templateUploadId] };
    expect(await (await post(swapped)).json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    await testDb.update(uploads).set({ status: 'rejected', url: null }).where(eq(uploads.id, body.userUploadIds[1]));
    const res = await post({ ...body, userUploadIds: body.userUploadIds.slice(0, 2) });
    expect(res.status).toBe(400);
    expect(await testDb.select().from(jobs)).toHaveLength(0);
  });

  it('is 401 without a session', async () => {
    cookieJar.clear();
    const res = await post({ templateUploadId: crypto.randomUUID(), userUploadIds: [crypto.randomUUID()] });
    expect(res.status).toBe(401);
  });
});
