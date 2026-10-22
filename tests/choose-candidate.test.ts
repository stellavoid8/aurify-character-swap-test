import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, uploads } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const fetchObject = vi.fn(async () => JPEG);
vi.mock('@/lib/storage', () => ({ fetchObject }));

vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('SESSION_SECRET', 'test-secret');

const { chooseCandidate } = await import('@/server/jobs/actions');
const { GET: download } = await import('@/app/api/jobs/[id]/download/route');
const { signSession, newSessionPayload } = await import('@/lib/session');

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
  cookieJar.clear();
  revalidatePath.mockClear();
  fetchObject.mockClear();
});

async function signInAs(sid: string) {
  cookieJar.set('cs_session', await signSession(newSessionPayload(sid)));
}

/** A finished job for `sid` with three candidates: rank 1 (chosen), rank 2, and one that failed. */
async function seedFinishedJob(sid = SID_A, status: 'succeeded' | 'running' = 'succeeded') {
  const [template] = await testDb
    .insert(uploads)
    .values({ sessionId: sid, kind: 'template', status: 'ok', rawUrl: 'https://e.test/t', url: 'https://e.test/t.jpg', width: 1, height: 1, bytes: 1 })
    .returning();
  const [job] = await testDb
    .insert(jobs)
    .values({ sessionId: sid, status, stage: 'done', templateUploadId: template.id, userUploadIds: [], currentRound: 1 })
    .returning();
  const [round] = await testDb
    .insert(jobRounds)
    .values({ jobId: job.id, sessionId: sid, round: 1, kind: 'generation', status: 'succeeded' })
    .returning();
  const base = { jobId: job.id, roundId: round.id, kind: 'generation' as const, model: 'test/model' };
  const [best, second, failed] = await testDb
    .insert(candidates)
    .values([
      { ...base, seed: 1, status: 'succeeded', imageUrl: 'https://e.test/r1.jpg', rank: 1 },
      { ...base, seed: 2, status: 'succeeded', imageUrl: 'https://e.test/r2.jpg', rank: 2 },
      { ...base, seed: 3, status: 'failed' },
    ])
    .returning();
  await testDb.update(jobs).set({ chosenCandidateId: best.id }).where(eq(jobs.id, job.id));
  return { jobId: job.id, best, second, failed };
}

const chosenOf = async (jobId: string) =>
  (await testDb.select({ id: jobs.chosenCandidateId }).from(jobs).where(eq(jobs.id, jobId)))[0].id;

describe('chooseCandidate', () => {
  it('sets the chosen candidate and revalidates the job page', async () => {
    const { jobId, second } = await seedFinishedJob();
    await signInAs(SID_A);

    const result = await chooseCandidate({ jobId, candidateId: second.id });

    expect(result).toEqual({ ok: true, data: { chosenCandidateId: second.id } });
    expect(await chosenOf(jobId)).toBe(second.id);
    expect(revalidatePath).toHaveBeenCalledWith(`/jobs/${jobId}`);
  });

  it("is JOB_NOT_FOUND for another session's job", async () => {
    const { jobId, best, second } = await seedFinishedJob(SID_A);
    await signInAs(SID_B);

    const result = await chooseCandidate({ jobId, candidateId: second.id });

    expect(result).toMatchObject({ ok: false, error: { code: 'JOB_NOT_FOUND' } });
    expect(await chosenOf(jobId)).toBe(best.id);
  });

  it("is JOB_NOT_FOUND for a candidate of the session's other job", async () => {
    const a = await seedFinishedJob();
    const b = await seedFinishedJob();
    await signInAs(SID_A);

    const result = await chooseCandidate({ jobId: a.jobId, candidateId: b.second.id });

    expect(result).toMatchObject({ ok: false, error: { code: 'JOB_NOT_FOUND' } });
    expect(await chosenOf(a.jobId)).toBe(a.best.id);
  });

  it('is INVALID_STATE for a failed candidate', async () => {
    const { jobId, failed } = await seedFinishedJob();
    await signInAs(SID_A);

    expect(await chooseCandidate({ jobId, candidateId: failed.id })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('is INVALID_STATE while the job is running', async () => {
    const { jobId, second, best } = await seedFinishedJob(SID_A, 'running');
    await signInAs(SID_A);

    expect(await chooseCandidate({ jobId, candidateId: second.id })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
    expect(await chosenOf(jobId)).toBe(best.id);
  });

  it('is VALIDATION_FAILED for malformed ids and ACCESS_DENIED without a session', async () => {
    await signInAs(SID_A);
    expect(await chooseCandidate({ jobId: 'nope', candidateId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });

    cookieJar.clear();
    const { jobId, second } = await seedFinishedJob();
    expect(await chooseCandidate({ jobId, candidateId: second.id })).toMatchObject({
      ok: false,
      error: { code: 'ACCESS_DENIED' },
    });
  });
});

describe('GET /api/jobs/[id]/download', () => {
  const get = (jobId: string, candidateId: string) =>
    download(new Request(`http://localhost:3000/api/jobs/${jobId}/download?candidate=${candidateId}`), {
      params: Promise.resolve({ id: jobId }),
    });

  it("sends the owner's candidate as a JPEG attachment", async () => {
    const { jobId, second } = await seedFinishedJob();
    await signInAs(SID_A);

    const res = await get(jobId, second.id);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="character-swap-${jobId.slice(0, 8)}-2.jpg"`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect(fetchObject).toHaveBeenCalledWith('https://e.test/r2.jpg');
  });

  it("is 404 JOB_NOT_FOUND for another session's candidate", async () => {
    const { jobId, best } = await seedFinishedJob(SID_A);
    await signInAs(SID_B);

    const res = await get(jobId, best.id);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('is 404 when the candidate belongs to a different job, or the id is missing', async () => {
    const a = await seedFinishedJob();
    const b = await seedFinishedJob();
    await signInAs(SID_A);

    expect((await get(a.jobId, b.best.id)).status).toBe(404);
    expect((await get(a.jobId, '')).status).toBe(404);
  });

  it('is 409 for a candidate without an image', async () => {
    const { jobId, failed } = await seedFinishedJob();
    await signInAs(SID_A);

    expect((await get(jobId, failed.id)).status).toBe(409);
  });
});
