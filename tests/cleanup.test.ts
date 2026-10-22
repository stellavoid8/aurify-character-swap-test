import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, uploads } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { seedJob } from './helpers/seed';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

const SID = '77777777-7777-4777-8777-777777777777';
// The raw sweep walks all of public/uploads; keep it to this test's folder so a developer's files are untouched.
vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return { ...actual, listObjects: () => actual.listObjects(`sessions/${SID}/`) };
});

vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('APP_URL', 'http://localhost:3000');
vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
vi.stubEnv('RETENTION_DAYS', '10');

const { runCleanup } = await import('@/server/cron/cleanup');

const ROOT = path.join(process.cwd(), 'public', 'uploads');
const DAY = 86_400_000;
const daysAgo = (days: number) => sql`now() - make_interval(secs => ${days * 86_400})`;

/** Writes a file under public/uploads and returns its local URL. `ageDays` backdates its mtime. */
function stored(pathname: string, ageDays = 0): string {
  const file = path.join(ROOT, pathname);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'bytes');
  if (ageDays) {
    const when = new Date(Date.now() - ageDays * DAY);
    utimesSync(file, when, when);
  }
  return `http://localhost:3000/uploads/${pathname}`;
}
const onDisk = (url: string) => existsSync(path.join(ROOT, new URL(url).pathname.replace(/^\/uploads\//, '')));

async function upload(name: string, ageDays: number, status: 'ok' | 'rejected' = 'ok') {
  const url = status === 'ok' ? stored(`sessions/${SID}/norm/${name}.jpg`) : null;
  const rawUrl = stored(`sessions/${SID}/raw/${name}.jpg`, ageDays);
  const [row] = await testDb
    .insert(uploads)
    .values({ sessionId: SID, kind: 'user', status, rawUrl, url, width: 1, height: 1, bytes: 1, createdAt: daysAgo(ageDays) })
    .returning();
  return row;
}

/** A finished job `ageDays` old with its own template/user uploads and a generated + refined picture. */
async function finishedJob(ageDays: number) {
  const template = await upload(`t-${ageDays}`, ageDays);
  const user = await upload(`u-${ageDays}`, ageDays);
  const [job] = await testDb
    .insert(jobs)
    .values({
      sessionId: SID,
      status: 'succeeded',
      stage: 'done',
      templateUploadId: template.id,
      userUploadIds: [user.id],
      referenceUploadId: user.id,
      createdAt: daysAgo(ageDays),
    })
    .returning();
  const [round] = await testDb.insert(jobRounds).values({ jobId: job.id, sessionId: SID, round: 1, kind: 'generation', status: 'succeeded' }).returning();
  const base = { jobId: job.id, roundId: round.id, model: 'm', seed: 1, status: 'succeeded' as const };
  const [parent] = await testDb
    .insert(candidates)
    .values({ ...base, kind: 'generation', imageUrl: stored(`results/${job.id}/a.jpg`) })
    .returning();
  const [child] = await testDb
    .insert(candidates)
    .values({ ...base, kind: 'refinement', parentCandidateId: parent.id, imageUrl: stored(`results/${job.id}/b.jpg`) })
    .returning();
  return { job, uploads: [template, user], images: [parent.imageUrl!, child.imageUrl!] };
}

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
  rmSync(path.join(ROOT, 'sessions', SID), { recursive: true, force: true });
});

describe('runCleanup', () => {
  it('times out stuck jobs and deletes expired jobs, orphan uploads and stale raw photos', async () => {
    const old = await finishedJob(11);
    const recent = await finishedJob(2);

    const stuckId = await seedJob(testDb, SID);
    await testDb
      .update(jobs)
      .set({ status: 'running', stage: 'generating', currentRound: 1, deadlineAt: sql`now() - interval '1 minute'` })
      .where(eq(jobs.id, stuckId));

    const rejected = await upload('rejected', 2, 'rejected');
    const draft = await upload('draft', 0);
    const staleRaw = stored(`sessions/${SID}/raw/leftover.jpg`, 2);
    const freshRaw = stored(`sessions/${SID}/raw/fresh.jpg`);
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const counts = await runCleanup();

    // Old job: 2 images and its 2 uploads (raw + normalized each); the rejected upload's raw; then the raw
    // sweep: the leftover raw plus the 2-day-old job's 2 raws (kept rows, but raws only live 24 h).
    expect(counts).toEqual({ timedOut: 1, deletedJobs: 1, deletedUploads: 3, deletedBlobs: 2 + 4 + 1 + 3 });

    expect(await testDb.select().from(jobs).where(eq(jobs.id, old.job.id))).toHaveLength(0);
    expect(await testDb.select().from(candidates).where(eq(candidates.jobId, old.job.id))).toHaveLength(0);
    for (const url of [...old.images, ...old.uploads.flatMap((u) => [u.rawUrl, u.url!]), rejected.rawUrl, staleRaw]) {
      expect(onDisk(url), url).toBe(false);
    }

    expect(await testDb.select().from(jobs).where(eq(jobs.id, recent.job.id))).toHaveLength(1);
    for (const url of [...recent.images, ...recent.uploads.map((u) => u.url!), draft.url!, freshRaw]) {
      expect(onDisk(url), url).toBe(true);
    }
    const left = await testDb.select({ id: uploads.id }).from(uploads);
    expect(left.map((u) => u.id)).toEqual(expect.arrayContaining([...recent.uploads.map((u) => u.id), draft.id]));
    expect(left.map((u) => u.id)).not.toContain(rejected.id);

    const [stuck] = await testDb.select().from(jobs).where(eq(jobs.id, stuckId));
    expect(stuck).toMatchObject({ status: 'timed_out', errorCode: 'JOB_TIMED_OUT' });

    // A second run finds nothing left to do.
    expect(await runCleanup()).toEqual({ timedOut: 0, deletedJobs: 0, deletedUploads: 0, deletedBlobs: 0 });
  });
});
