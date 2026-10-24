import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobRounds, jobs, providerCalls, uploads } from '@/lib/db/schema';
import type { Face, FaceBox } from '@/lib/types';
import { createTestDb, type TestDb } from './helpers/db';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

/** The "image bytes" are the candidate's URL, so the face mock can look up what each one shows. */
vi.mock('@/lib/storage', () => ({ fetchObject: vi.fn(async (url: string) => Buffer.from(url)) }));

/** Per image URL: the faces found (pixel coordinates of a 100×100 image) and each face's embedding. */
const scene = vi.hoisted(() => ({
  images: new Map<string, { face: Face; embedding: number[] }[]>(),
  crash: false,
}));
vi.mock('@/lib/face', async () => {
  const { cosine } = await import('@/lib/face/arcface');
  return {
    cosine,
    faceEngine: {
      get name() {
        if (scene.crash) throw new Error('engine exploded');
        return 'mock';
      },
      analyzeImage: vi.fn(async (jpeg: Buffer) => ({
        faces: (scene.images.get(jpeg.toString()) ?? []).map((f) => f.face),
        width: 100,
        height: 100,
      })),
      embedFace: vi.fn(async (jpeg: Buffer, face: Face) => scene.images.get(jpeg.toString())!.find((f) => f.face === face)!.embedding),
    },
  };
});

const rateAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai', () => ({ ai: { rateAction } }));

const { onRoundGenerated } = await import('@/lib/pipeline/orchestrator');

const SID = '88888888-8888-4888-8888-888888888888';
const REFERENCE = [1, 0, 0, 0];

/** A unit vector whose cosine with REFERENCE is `c`. */
const withCosine = (c: number) => [c, Math.sqrt(1 - c * c), 0, 0];

/** A 20×20 px face centred at (cx, cy) in the 100×100 candidate image. */
const faceAt = (cx: number, cy: number): Face => ({
  box: [cx - 10, cy - 10, 20, 20],
  score: 0.9,
  landmarks: [],
});

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate jobs, uploads, provider_calls cascade`);
  scene.images.clear();
  scene.crash = false;
  rateAction.mockReset();
});

/**
 * A job in `ranking` with one succeeded candidate per entry of `results`, completed in that order.
 * Each entry lists the faces in that candidate's image as [centre x, centre y, cosine to the user].
 */
async function seedRound(
  results: [number, number, number][][],
  { templateFaces = [{ box: [0.6, 0.4, 0.2, 0.2], score: 0.9, landmarks: [] }] }: { templateFaces?: FaceBox[] } = {},
) {
  const [template] = await testDb
    .insert(uploads)
    .values({
      sessionId: SID,
      kind: 'template',
      status: 'ok',
      rawUrl: 'https://example.test/t.jpg',
      url: 'https://example.test/t.jpg',
      width: 100,
      height: 100,
      bytes: 1,
      // The subject stands on the right.
      faces: templateFaces,
      subjectFaceIndex: 0,
    })
    .returning();
  const [user] = await testDb
    .insert(uploads)
    .values({ sessionId: SID, kind: 'user', status: 'ok', rawUrl: 'https://example.test/u.jpg', url: 'https://example.test/u.jpg', width: 100, height: 100, bytes: 1, embedding: REFERENCE })
    .returning();
  const [job] = await testDb
    .insert(jobs)
    .values({ sessionId: SID, status: 'running', stage: 'ranking', templateUploadId: template.id, userUploadIds: [user.id], referenceUploadId: user.id, currentRound: 1 })
    .returning();
  const [round] = await testDb.insert(jobRounds).values({ jobId: job.id, sessionId: SID, round: 1, kind: 'generation' }).returning();

  const ids: string[] = [];
  for (const [i, faces] of results.entries()) {
    const imageUrl = `https://example.test/c${i + 1}.jpg`;
    scene.images.set(
      imageUrl,
      faces.map(([cx, cy, c]) => ({ face: faceAt(cx, cy), embedding: withCosine(c) })),
    );
    const [row] = await testDb
      .insert(candidates)
      .values({
        jobId: job.id,
        roundId: round.id,
        kind: 'generation',
        model: 'test/model',
        seed: i,
        status: 'succeeded',
        imageUrl,
        completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })
      .returning();
    ids.push(row.id);
  }
  return { jobId: job.id, roundId: round.id, ids };
}

const candidate = async (id: string) => (await testDb.select().from(candidates).where(eq(candidates.id, id)))[0];
const jobRow = async (id: string) => (await testDb.select().from(jobs).where(eq(jobs.id, id)))[0];

describe('rankRound via onRoundGenerated', () => {
  it('ranks by cosine to the user, puts a candidate with no face last, and finishes the job', async () => {
    const { jobId, roundId, ids } = await seedRound([[[70, 50, 0.5]], [[70, 50, 0.8]], []]);
    await onRoundGenerated(roundId);

    const [c1, c2, c3] = await Promise.all(ids.map(candidate));
    expect(c2).toMatchObject({ rank: 1, scorer: 'mock' });
    expect(c1).toMatchObject({ rank: 2, scorer: 'mock' });
    expect(c3).toMatchObject({ rank: 3, scorer: 'mock', identityScore: null });
    expect(c2.identityScore).toBeCloseTo(0.8, 5);
    expect(c1.identityScore).toBeCloseTo(0.5, 5);
    expect(rateAction).not.toHaveBeenCalled();

    expect(await jobRow(jobId)).toMatchObject({ status: 'succeeded', stage: 'done', chosenCandidateId: ids[1] });
    const [round] = await testDb.select().from(jobRounds).where(eq(jobRounds.id, roundId));
    expect(round.status).toBe('succeeded');
    expect(round.stageTimings.ranking?.endedAt).toBeTruthy();

    // Every candidate's score has a recorded reason.
    const calls = await testDb.select().from(providerCalls).where(eq(providerCalls.model, 'mock-identity'));
    expect(Object.fromEntries(calls.map((c) => [c.candidateId, c.meta.reason]))).toEqual({
      [ids[0]]: 'scored',
      [ids[1]]: 'scored',
      [ids[2]]: 'no_face',
    });
  });

  it('scores the face nearest the template subject, not the best-matching one', async () => {
    // Left face is a near-perfect match but sits where the subject isn't; the right face is the swap.
    const { ids, roundId } = await seedRound([[[20, 50, 0.99], [70, 50, 0.4]], [[70, 50, 0.6]]], {
      templateFaces: [
        { box: [0.6, 0.4, 0.2, 0.2], score: 0.9, landmarks: [] },
        { box: [0.1, 0.4, 0.2, 0.2], score: 0.9, landmarks: [] },
      ],
    });
    await onRoundGenerated(roundId);

    const [c1, c2] = await Promise.all(ids.map(candidate));
    expect(c1.identityScore).toBeCloseTo(0.4, 5);
    expect(c2.rank).toBe(1);
  });

  it('leaves out the likeness of a result with more faces than the template and ranks it last', async () => {
    // Candidate 1 is a collage: its swap panel matches the user best, but the template has one face.
    const { jobId, roundId, ids } = await seedRound([[[70, 50, 0.9], [20, 50, 0.9]], [[70, 50, 0.5]], []]);
    await onRoundGenerated(roundId);

    const [c1, c2, c3] = await Promise.all(ids.map(candidate));
    expect(c2.rank).toBe(1);
    expect(c1).toMatchObject({ rank: 2, identityScore: null });
    expect(c3.rank).toBe(3);
    expect((await jobRow(jobId)).chosenCandidateId).toBe(ids[1]);
    const calls = await testDb.select().from(providerCalls).where(eq(providerCalls.model, 'mock-identity'));
    expect(calls.find((c) => c.candidateId === ids[0])?.meta).toMatchObject({ reason: 'extra_faces', faceCount: 2, templateFaceCount: 1 });
  });

  it('ranks a result that kept the template face below every clean result', async () => {
    // The template subject's embedding has cosine 0.6 with the user's: someone who looks alike.
    const templateSubject = withCosine(0.6);
    scene.images.set('https://example.test/t.jpg', [{ face: faceAt(70, 50), embedding: templateSubject }]);
    const { roundId, ids } = await seedRound([[[70, 50, 0.6]], [[70, 50, 0.45]]]);
    // Candidate 1 is the template subject unchanged; candidate 2 is a weaker but real swap.
    scene.images.get('https://example.test/c1.jpg')![0].embedding = templateSubject;
    scene.images.get('https://example.test/c2.jpg')![0].embedding = [0.45, -Math.sqrt(1 - 0.45 ** 2), 0, 0];
    await onRoundGenerated(roundId);

    const [c1, c2] = await Promise.all(ids.map(candidate));
    expect(c2.rank).toBe(1);
    expect(c1.rank).toBe(2);
    // Its likeness is still measured, so Fix the face can show before and after.
    expect(c1.identityScore).toBeCloseTo(0.6, 5);
    expect(rateAction).not.toHaveBeenCalled();
    const calls = await testDb.select().from(providerCalls).where(eq(providerCalls.model, 'mock-identity'));
    expect(calls.find((c) => c.candidateId === ids[0])?.meta).toMatchObject({ reason: 'template_face' });
    expect(calls.find((c) => c.candidateId === ids[1])?.meta).toMatchObject({ reason: 'scored' });
  });

  it('settles a close top two with one action rating', async () => {
    rateAction.mockResolvedValue({
      result: {
        scores: [
          { index: 1, score: 2, reason: 'stiff pose' },
          { index: 2, score: 5, reason: 'matches the jump' },
        ],
      },
      usage: { inputTokens: 0, outputTokens: 0, costUsdMicros: 0 },
    });
    const { jobId, roundId, ids } = await seedRound([[[70, 50, 0.7]], [[70, 50, 0.71]], [[70, 50, 0.2]]]);
    await onRoundGenerated(roundId);

    expect(rateAction).toHaveBeenCalledTimes(1);
    expect(rateAction.mock.calls[0][0]).toMatchObject({
      templateUrl: 'https://example.test/t.jpg',
      candidateUrls: ['https://example.test/c2.jpg', 'https://example.test/c1.jpg'],
    });
    const [c1, c2, c3] = await Promise.all(ids.map(candidate));
    // 0.70 + 0.02 × 5 beats 0.71 + 0.02 × 2.
    expect(c1).toMatchObject({ rank: 1, actionScore: 5 });
    expect(c2).toMatchObject({ rank: 2, actionScore: 2 });
    expect(c3).toMatchObject({ rank: 3, actionScore: null });
    expect((await jobRow(jobId)).chosenCandidateId).toBe(ids[0]);
  });

  it('keeps identity order when the action rating fails', async () => {
    rateAction.mockRejectedValue(new Error('provider down'));
    const { roundId, ids } = await seedRound([[[70, 50, 0.7]], [[70, 50, 0.71]]]);
    await onRoundGenerated(roundId);

    expect((await candidate(ids[1])).rank).toBe(1);
  });

  it('still succeeds the job with the earliest result when ranking crashes', async () => {
    scene.crash = true;
    const { jobId, roundId, ids } = await seedRound([[[70, 50, 0.5]], [[70, 50, 0.9]]]);
    await onRoundGenerated(roundId);

    expect(await jobRow(jobId)).toMatchObject({ status: 'succeeded', stage: 'done', chosenCandidateId: ids[0] });
    const rows = await Promise.all(ids.map(candidate));
    expect(rows.map((c) => c.rank)).toEqual([1, 2]);
    expect(rows.every((c) => c.scorer === null && c.identityScore === null)).toBe(true);
  });
});
