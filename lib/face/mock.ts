import sharp from 'sharp';
import type { Face } from '../types';
import { ARCFACE_SIZE, ARCFACE_TEMPLATE } from './align';
import { EMBEDDING_DIM, l2Normalize } from './arcface';

/**
 * Deterministic stand-in for the ONNX engine (dev without models, tests, e2e).
 * The image's mean colour picks the outcome, so fixtures can trigger each face-check path:
 * mostly red → no face, mostly blue → two faces, anything else → one centred face covering 20% of the image.
 * The embedding is a seeded hash of the downsampled face pixels: the same pixels always give the same vector.
 */

/** A channel "dominates" when it beats both others by this much (0–255 mean). */
const DOMINANCE = 60;
const MOCK_SCORE = 0.9;
const HASH_SIZE = 8;

export type MockOutcome = 'none' | 'one' | 'two';

export function outcomeForColor(r: number, g: number, b: number): MockOutcome {
  if (r - Math.max(g, b) >= DOMINANCE) return 'none';
  if (b - Math.max(r, g) >= DOMINANCE) return 'two';
  return 'one';
}

/** A frontal face filling the box, with landmarks where ArcFace expects them. */
function faceInBox(x: number, y: number, w: number, h: number): Face {
  return {
    box: [x, y, w, h],
    score: MOCK_SCORE,
    landmarks: ARCFACE_TEMPLATE.map(([lx, ly]) => [x + (lx / ARCFACE_SIZE) * w, y + (ly / ARCFACE_SIZE) * h]),
  };
}

export function mockFaces(outcome: MockOutcome, width: number, height: number): Face[] {
  if (outcome === 'none') return [];
  if (outcome === 'one') {
    // Same aspect as the image, so the box covers exactly 20% of its area.
    const side = Math.sqrt(0.2);
    const w = width * side, h = height * side;
    return [faceInBox((width - w) / 2, (height - h) / 2, w, h)];
  }
  // Two side-by-side faces, each 5% of the image: above FACE_MIN_AREA_FRAC, so both count.
  const w = width * 0.2, h = height * 0.25;
  return [faceInBox(width * 0.2, (height - h) / 2, w, h), faceInBox(width * 0.6, (height - h) / 2, w, h)];
}

export async function mockAnalyzeImage(jpeg: Buffer): Promise<{ faces: Face[]; width: number; height: number }> {
  const image = sharp(jpeg).removeAlpha();
  const [{ width = 0, height = 0 }, stats] = await Promise.all([image.metadata(), image.stats()]);
  const [r, g, b] = stats.channels.map((c) => c.mean);
  return { faces: mockFaces(outcomeForColor(r, g, b), width, height), width, height };
}

/** 32-bit FNV-1a. */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

/** mulberry32: small seeded PRNG, uniform in [0, 1). */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function embeddingFromSeed(seed: number): number[] {
  const next = prng(seed);
  return Array.from(l2Normalize(Float32Array.from({ length: EMBEDDING_DIM }, () => next() * 2 - 1)));
}

export async function mockEmbedFace(jpeg: Buffer, face: Face): Promise<number[]> {
  const meta = await sharp(jpeg).metadata();
  const [x, y, w, h] = face.box;
  const left = Math.max(0, Math.floor(x)), top = Math.max(0, Math.floor(y));
  const region = {
    left,
    top,
    width: Math.max(1, Math.min((meta.width ?? 1) - left, Math.round(w))),
    height: Math.max(1, Math.min((meta.height ?? 1) - top, Math.round(h))),
  };
  const pixels = await sharp(jpeg)
    .removeAlpha()
    .extract(region)
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  return embeddingFromSeed(fnv1a(pixels));
}
