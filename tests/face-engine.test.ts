import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerCalls } from '@/lib/db/schema';
import { decodeStride, nms } from '@/lib/face/scrfd';
import { onnxModelsPresent } from '@/lib/face/onnx';
import type { Face } from '@/lib/types';
import { createTestDb, type TestDb } from './helpers/db';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await testDb.delete(providerCalls);
});

async function loadEngine(mode: 'auto' | 'onnx' | 'mock') {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  vi.stubEnv('FACE_ENGINE', mode);
  return import('@/lib/face');
}

const grey = () => readFile('tests/fixtures/face-one-grey.jpg');

describe('faceEngine (mock)', () => {
  it('reports its name and records a provider_calls row per call', async () => {
    const { faceEngine } = await loadEngine('mock');
    expect(faceEngine.name).toBe('mock');

    const jpeg = await grey();
    const { faces, width, height } = await faceEngine.analyzeImage(jpeg, { stage: 'upload-check' });
    expect([faces.length, width, height]).toEqual([1, 640, 480]);
    const embedding = await faceEngine.embedFace(jpeg, faces[0]);
    expect(embedding).toHaveLength(512);

    const rows = await testDb.select().from(providerCalls);
    expect(rows.map((r) => [r.provider, r.model, r.stage, r.status, r.costUsdMicros])).toEqual(
      expect.arrayContaining([
        ['local', 'mock-face', 'upload-check', 'ok', 0],
        ['local', 'mock-face', 'face-embed', 'ok', 0],
      ]),
    );
    expect(rows.find((r) => r.stage === 'upload-check')?.meta).toEqual({ faces: 1 });
  });

  it('records an error row and rethrows when the image is unreadable', async () => {
    const { faceEngine } = await loadEngine('mock');
    await expect(faceEngine.analyzeImage(Buffer.from('not an image'))).rejects.toThrow();
    const [row] = await testDb.select().from(providerCalls);
    expect(row).toMatchObject({ provider: 'local', stage: 'face-detect', status: 'error' });
  });
});

describe('toFaceBox / fromFaceBox', () => {
  it('round-trips between pixels and normalized coordinates', async () => {
    const { toFaceBox, fromFaceBox } = await loadEngine('mock');
    const face: Face = { box: [100, 50, 200, 100], score: 0.9, landmarks: [[150, 80], [250, 80], [200, 100], [160, 130], [240, 130]] };
    const stored = toFaceBox(face, 400, 200);
    expect(stored.box).toEqual([0.25, 0.25, 0.5, 0.5]);
    expect(stored.landmarks[0]).toEqual([0.375, 0.4]);
    expect(fromFaceBox(stored, 400, 200)).toEqual(face);
  });
});

describe('SCRFD decoding', () => {
  it('decodes distances around the anchor centre, row by row, two anchors per cell', () => {
    // 32 px input at stride 16: a 2×2 grid, 8 anchors. Only anchor 7 (cell 3 = row 1, col 1, second anchor) fires.
    const scores = new Float32Array(8);
    scores[7] = 0.9;
    const boxes = new Float32Array(32);
    boxes.set([0.5, 0.25, 1, 0.75], 7 * 4);
    const kps = new Float32Array(80);
    kps.set([0, 0, 0.5, 0.5, -0.5, 1, 0, 0, 0, 0], 7 * 10);

    const [face, ...rest] = decodeStride(16, scores, boxes, kps, 32, 0.4);
    expect(rest).toEqual([]);
    expect(face.box).toEqual([8, 12, 24, 16]);
    expect(face.landmarks.slice(0, 3)).toEqual([[16, 16], [24, 24], [8, 32]]);
  });

  it('NMS keeps the best of overlapping boxes and keeps separate faces', () => {
    const f = (x: number, score: number): Face => ({ box: [x, 0, 100, 100], score, landmarks: [] });
    const kept = nms([f(0, 0.7), f(10, 0.9), f(500, 0.6)], 0.4);
    expect(kept.map((k) => k.score)).toEqual([0.9, 0.6]);
  });
});

describe.skipIf(!onnxModelsPresent())('faceEngine (onnx, needs /models)', () => {
  it('finds no face in a flat image and embeds a crop to a unit vector', async () => {
    const { faceEngine } = await loadEngine('auto');
    expect(faceEngine.name).toBe('onnx');
    const jpeg = await grey();
    expect((await faceEngine.analyzeImage(jpeg)).faces).toEqual([]);
    const fake: Face = { box: [200, 100, 240, 280], score: 1, landmarks: [[280, 220], [360, 220], [320, 260], [290, 300], [350, 300]] };
    const embedding = await faceEngine.embedFace(jpeg, fake);
    expect(embedding).toHaveLength(512);
    expect(Math.hypot(...embedding)).toBeCloseTo(1, 5);
    const rows = await testDb.select().from(providerCalls);
    expect(rows.map((r) => r.model).sort()).toEqual(['arcface-w600k-mbf', 'scrfd-500m']);
  });
});
