import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
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

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

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

/**
 * Stands in for the fal queue: records each submission; the test delivers the webhooks itself.
 * The ffmpeg utilities run the real mock (lib/fal/mock.ts) unless a test overrides the probe.
 */
type Submission = { model: string; requestId: string; input: Record<string, unknown>; webhookUrl: string };
const fal = vi.hoisted(() => ({ submissions: [] as Submission[], next: 0, probe: null as unknown }));
vi.mock('@/lib/fal/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/fal/client')>();
  return {
    ...actual,
    submitToQueue: vi.fn(async ({ model, input, webhookUrl }: Omit<Submission, 'requestId'>) => {
      const requestId = `req-${++fal.next}`;
      fal.submissions.push({ model, requestId, input, webhookUrl });
      return { requestId };
    }),
    runUtility: vi.fn(async (args: Parameters<typeof actual.runUtility>[0]) =>
      args.model === 'fal-ai/ffmpeg-api/metadata' && fal.probe ? fal.probe : actual.runUtility(args),
    ),
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
vi.stubEnv('VIDEO_ENABLED', 'true');

const { animateCandidate, refineCandidate } = await import('@/server/jobs/actions');
const { normalizeUpload } = await import('@/server/uploads/actions');
const { POST: createJobRoute } = await import('@/app/api/jobs/route');
const { POST: webhookRoute } = await import('@/app/api/webhooks/fal/route');
const { GET: downloadRoute } = await import('@/app/api/jobs/[id]/download/route');
const { signSession, newSessionPayload } = await import('@/lib/session');
const { putObject } = await import('@/lib/storage');
const { env } = await import('@/lib/env');
const { mockWebhookBody, MOCK_VIDEO } = await import('@/lib/fal/mock');
const { VIDEO_MODEL } = await import('@/lib/fal/models');
const { VIDEO_PRICES } = await import('@/lib/fal/pricing');
const { faceEngine } = await import('@/lib/face');
const { enforceTimeout } = await import('@/lib/pipeline/timeout');
const { getJobView } = await import('@/server/jobs/view');
const { ANIMATION_RESOLUTION, ANIMATION_ROUND_UNITS, ANIMATION_TIMEOUT_MS, SESSION_DAILY_UNITS, VIDEO_TARGET_FPS } = await import('@/lib/limits');

const SID = '77777777-7777-4777-8777-777777777777';
const UPLOADS = path.join(process.cwd(), 'public', 'uploads');
const FIXTURE = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'face-one-grey.jpg'));
let photoUrl: string;
let embedding: number[];

function setFailureMode(mode: 'none' | 'once' | 'always') {
  (env as { MOCK_FAL_FAILURE_MODE: string }).MOCK_FAL_FAILURE_MODE = mode;
}
function setVideoEnabled(on: boolean) {
  (env as { VIDEO_ENABLED: boolean }).VIDEO_ENABLED = on;
}

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
  ({ url: photoUrl } = await putObject(`sessions/${SID}/video-test/photo.jpg`, FIXTURE, 'image/jpeg'));
  const { faces } = await faceEngine.analyzeImage(FIXTURE);
  embedding = await faceEngine.embedFace(FIXTURE, faces[0]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(path.join(UPLOADS, 'sessions', SID), { recursive: true, force: true });
  rmSync(path.join(UPLOADS, 'results'), { recursive: true, force: true });
  rmSync(path.join(UPLOADS, 'mock-frames'), { recursive: true, force: true });
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads, provider_calls, webhook_events cascade`);
  afterQueue.length = 0;
  fal.submissions.length = 0;
  fal.probe = null;
  setFailureMode('none');
  setVideoEnabled(true);
  cookieJar.set('cs_session', await signSession(newSessionPayload(SID)));
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
const candidateRows = (jobId: string) => testDb.select().from(candidates).where(eq(candidates.jobId, jobId));

/** A raw clip in this session's raw folder, as the browser would upload it. The mock probe never reads its bytes. */
async function rawClip(): Promise<string> {
  const { url } = await putObject(`sessions/${SID}/raw/${crypto.randomUUID()}.mp4`, Buffer.from('not really an mp4'), 'video/mp4');
  return url;
}

async function videoTemplate() {
  const result = await normalizeUpload({ kind: 'template', media: 'video', rawUrl: await rawClip() });
  if (!result.ok) throw new Error(`normalize failed: ${result.error.code}`);
  return result.data;
}

/** A video job of SID through POST /api/jobs, with one user photo. Nothing is delivered yet. */
async function createVideoJob(): Promise<{ status: number; jobId?: string; code?: string }> {
  const template = await videoTemplate();
  const [user] = await testDb
    .insert(uploads)
    .values({ sessionId: SID, kind: 'user', status: 'ok', rawUrl: photoUrl, url: photoUrl, width: 10, height: 10, bytes: 1, embedding })
    .returning();
  const res = await createJobRoute(
    new Request('http://localhost:3000/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateUploadId: template.id, userUploadIds: [user.id] }),
    }),
  );
  const body = await res.json();
  return { status: res.status, jobId: body.data?.jobId, code: body.error?.code };
}

/** Round 1's three stills, delivered. The orchestrator then chains and submits the animation. */
async function deliverStills(jobId: string) {
  await drain();
  const stills = fal.submissions.length;
  expect(stills).toBe(3);
  const batch = fal.submissions.slice(0, stills);
  await Promise.all(batch.map((s) => callWebhook(s.webhookUrl, mockWebhookBody(s.requestId, s.input, attemptOf(s.webhookUrl)))));
  await drain();
  return jobRow(jobId);
}

describe('normalizeUpload of a template clip', () => {
  it('stores the re-encoded clip and a keyframe, and deletes the raw upload', async () => {
    const rawUrl = await rawClip();
    const result = await normalizeUpload({ kind: 'template', media: 'video', rawUrl });

    expect(result).toMatchObject({ ok: true, data: { kind: 'template', mediaType: 'video', status: 'ok', durationMs: MOCK_VIDEO.durationSeconds * 1000 } });
    const view = result.ok ? result.data : null;
    expect(view?.videoUrl).toMatch(/\/uploads\/sessions\/.+\/clips\/.+\.mp4$/);
    expect(view?.url).toMatch(/\/uploads\/sessions\/.+\/norm\/.+\.jpg$/);
    expect(view?.faceCount).toBe(1);

    const [row] = await testDb.select().from(uploads).where(eq(uploads.id, view!.id));
    expect(row).toMatchObject({ fps: VIDEO_TARGET_FPS, frameCount: MOCK_VIDEO.durationSeconds * VIDEO_TARGET_FPS, keyframe: 'first' });
    expect(existsSync(path.join(UPLOADS, new URL(rawUrl).pathname.replace('/uploads/', '')))).toBe(false);
  });

  it('rejects a clip over 15 seconds with VIDEO_TOO_LONG and keeps nothing', async () => {
    fal.probe = { media: { duration: 15.6, fps: 30, resolution: { width: 1080, height: 1920 } } };

    const result = await normalizeUpload({ kind: 'template', media: 'video', rawUrl: await rawClip() });

    expect(result).toMatchObject({ ok: false, error: { code: 'VIDEO_TOO_LONG' } });
    expect(await testDb.select().from(uploads)).toHaveLength(0);
  });

  it('accepts a clip of exactly 15 seconds', async () => {
    fal.probe = { media: { duration: 15.04, fps: 60, resolution: { width: 2160, height: 3840 } } };

    const result = await normalizeUpload({ kind: 'template', media: 'video', rawUrl: await rawClip() });

    expect(result).toMatchObject({ ok: true, data: { durationMs: 15_040 } });
    const [row] = await testDb.select().from(uploads);
    // Billed frames come from the re-encoded rate, not the phone's 60 fps.
    expect(row.frameCount).toBe(Math.round(15.04 * VIDEO_TARGET_FPS));
  });

  it('is VIDEO_DECODE_FAILED when the probe has no duration', async () => {
    fal.probe = { media: { codec: 'unknown' } };
    expect(await normalizeUpload({ kind: 'template', media: 'video', rawUrl: await rawClip() })).toMatchObject({
      ok: false,
      error: { code: 'VIDEO_DECODE_FAILED' },
    });
  });

  it('is VIDEO_UNAVAILABLE while the flag is off, and VALIDATION_FAILED for a user photo clip', async () => {
    setVideoEnabled(false);
    expect(await normalizeUpload({ kind: 'template', media: 'video', rawUrl: await rawClip() })).toMatchObject({
      ok: false,
      error: { code: 'VIDEO_UNAVAILABLE' },
    });
    setVideoEnabled(true);
    expect(await normalizeUpload({ kind: 'user', media: 'video', rawUrl: await rawClip() })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
  });
});

describe('a video job', () => {
  it('makes stills, then animates the best one into the chosen version', async () => {
    const { status, jobId } = await createVideoJob();
    expect(status).toBe(201);
    expect(await jobRow(jobId!)).toMatchObject({ mode: 'video', status: 'running' });

    const afterStills = await deliverStills(jobId!);
    const stillsChosen = afterStills.chosenCandidateId;
    const animationSubmissions = fal.submissions.filter((s) => s.model === VIDEO_MODEL);
    expect(animationSubmissions).toHaveLength(1);
    const [template] = await testDb.select().from(uploads).where(eq(uploads.id, afterStills.templateUploadId));
    const [best] = await testDb.select().from(candidates).where(eq(candidates.id, stillsChosen!));
    expect(animationSubmissions[0].input).toMatchObject({
      video_url: template.videoUrl,
      image_url: best.imageUrl,
      resolution: ANIMATION_RESOLUTION,
      enable_output_safety_checker: true,
    });
    expect(afterStills).toMatchObject({ status: 'running', stage: 'animating', currentRound: 2 });
    const deadlineLeft = afterStills.deadlineAt!.getTime() - Date.now();
    expect(deadlineLeft).toBeGreaterThan(ANIMATION_TIMEOUT_MS - 10_000);

    await deliverAll();

    const job = await jobRow(jobId!);
    const video = (await candidateRows(jobId!)).find((c) => c.kind === 'animation')!;
    expect(job).toMatchObject({ status: 'succeeded', stage: 'done', chosenCandidateId: video.id });
    expect(video).toMatchObject({ status: 'succeeded', parentCandidateId: stillsChosen, imageUrl: best.imageUrl });
    expect(video.videoUrl).toMatch(new RegExp(`/uploads/results/${jobId}/${video.id}\\.mp4$`));
    expect(video.identityScore).toEqual(expect.any(Number));
    expect(video.costUsdMicros).toBe(
      Math.round(((MOCK_VIDEO.durationSeconds * VIDEO_TARGET_FPS) / 16) * VIDEO_PRICES[ANIMATION_RESOLUTION].perVideoSecondUsdMicros),
    );
    expect((await roundRows(jobId!)).map((r) => [r.round, r.kind, r.status, r.units])).toEqual([
      [1, 'generation', 'succeeded', 1],
      [2, 'animation', 'succeeded', ANIMATION_ROUND_UNITS],
    ]);

    const view = await getJobView(SID, jobId!);
    expect(view).toMatchObject({ mode: 'video', canAnimate: true, canRefine: false, template: { videoUrl: template.videoUrl } });
    expect(view.candidates.find((c) => c.id === video.id)).toMatchObject({ kind: 'animation', videoUrl: video.videoUrl });

    const res = await downloadRoute(new Request(`http://localhost:3000/api/jobs/${jobId}/download?candidate=${video.id}`), {
      params: Promise.resolve({ id: jobId! }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toContain('-video.mp4');
  });

  it('keeps the stills, with ANIMATION_FAILED, when the video fails after its retry', async () => {
    const { jobId } = await createVideoJob();
    const afterStills = await deliverStills(jobId!);
    setFailureMode('always');

    await deliverAll();

    const job = await jobRow(jobId!);
    expect(job).toMatchObject({ status: 'succeeded', stage: 'done', chosenCandidateId: afterStills.chosenCandidateId });
    expect(job.notices).toContainEqual({ code: 'ANIMATION_FAILED' });
    const video = (await candidateRows(jobId!)).find((c) => c.kind === 'animation')!;
    expect(video).toMatchObject({ status: 'failed', errorCode: 'ANIMATION_FAILED', attempt: 2 });
    expect((await roundRows(jobId!)).at(-1)).toMatchObject({ kind: 'animation', status: 'failed' });
  });

  it('times an animation out into a succeeded job with its stills', async () => {
    const { jobId } = await createVideoJob();
    await deliverStills(jobId!);
    await testDb.update(jobs).set({ deadlineAt: sql`now() - interval '1 minute'` }).where(eq(jobs.id, jobId!));

    const job = await enforceTimeout(await jobRow(jobId!));

    expect(job).toMatchObject({ status: 'succeeded', stage: 'done' });
    expect(job.notices).toContainEqual({ code: 'ANIMATION_FAILED' });
    expect((await roundRows(jobId!)).at(-1)).toMatchObject({ kind: 'animation', status: 'timed_out' });
  });

  it('needs the units for the stills and the video up front', async () => {
    await seedRounds(testDb, SID, SESSION_DAILY_UNITS - ANIMATION_ROUND_UNITS);
    const { status, code } = await createVideoJob();
    expect(status).toBe(429);
    expect(code).toBe('RATE_LIMITED_SESSION');
  });

  it('counts an animation round as ANIMATION_ROUND_UNITS units', async () => {
    const { jobId } = await createVideoJob();
    await deliverStills(jobId!);
    const view = await getJobView(SID, jobId!);
    expect(view.unitsLeftToday).toBe(SESSION_DAILY_UNITS - 1 - ANIMATION_ROUND_UNITS);
  });
});

describe('animateCandidate', () => {
  it('animates another still in a new round and makes that video the chosen version', async () => {
    const { jobId } = await createVideoJob();
    await deliverStills(jobId!);
    await deliverAll();
    fal.submissions.length = 0;
    const other = (await candidateRows(jobId!)).find((c) => c.kind === 'generation' && c.rank === 2)!;

    const result = await animateCandidate({ jobId: jobId!, candidateId: other.id });

    expect(result).toMatchObject({ ok: true, data: { round: 3 } });
    expect(await jobRow(jobId!)).toMatchObject({ status: 'running', stage: 'animating', currentRound: 3 });
    await drain();
    expect(fal.submissions).toHaveLength(1);
    expect(fal.submissions[0].input).toMatchObject({ image_url: other.imageUrl });
    await deliverAll();
    const video = (await candidateRows(jobId!)).find((c) => c.kind === 'animation' && c.parentCandidateId === other.id)!;
    expect(await jobRow(jobId!)).toMatchObject({ status: 'succeeded', chosenCandidateId: video.id });
  });

  it('refuses a video as the still to animate, and Fix the face refuses a video too', async () => {
    const { jobId } = await createVideoJob();
    await deliverStills(jobId!);
    await deliverAll();
    const video = (await candidateRows(jobId!)).find((c) => c.kind === 'animation')!;

    expect(await animateCandidate({ jobId: jobId!, candidateId: video.id })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(await refineCandidate({ jobId: jobId!, candidateId: video.id })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
  });

  it('is INVALID_STATE for a photo job', async () => {
    const [template] = await testDb
      .insert(uploads)
      .values({ sessionId: SID, kind: 'template', status: 'ok', rawUrl: photoUrl, url: photoUrl, width: 10, height: 10, bytes: 1 })
      .returning();
    const [job] = await testDb
      .insert(jobs)
      .values({ sessionId: SID, status: 'succeeded', stage: 'done', templateUploadId: template.id, userUploadIds: [], currentRound: 1 })
      .returning();
    const [round] = await testDb.insert(jobRounds).values({ jobId: job.id, sessionId: SID, round: 1, kind: 'generation' }).returning();
    const [still] = await testDb
      .insert(candidates)
      .values({ jobId: job.id, roundId: round.id, kind: 'generation', model: 'm', seed: 1, status: 'succeeded', imageUrl: photoUrl })
      .returning();

    expect(await animateCandidate({ jobId: job.id, candidateId: still.id })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(await testDb.select().from(jobRounds).where(and(eq(jobRounds.jobId, job.id), eq(jobRounds.kind, 'animation')))).toHaveLength(0);
  });
});
