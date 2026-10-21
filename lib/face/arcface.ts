import type { RgbImage } from '../types';
import { ARCFACE_SIZE } from './align';
import { getSession, loadOrt } from './onnx';

/** ArcFace MobileFaceNet (InsightFace buffalo_s `w600k_mbf.onnx`): aligned 112×112 face → 512-d identity vector. */

export const EMBEDDING_DIM = 512;

/** L2-normalized embedding of a face already aligned with `alignFace`. */
export async function embed(aligned: RgbImage): Promise<Float32Array> {
  if (aligned.width !== ARCFACE_SIZE || aligned.height !== ARCFACE_SIZE) {
    throw new Error(`embed expects a ${ARCFACE_SIZE}×${ARCFACE_SIZE} aligned face`);
  }
  const plane = ARCFACE_SIZE * ARCFACE_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (aligned.data[i * 3 + c] - 127.5) / 127.5;
  }
  const [ort, session] = await Promise.all([loadOrt(), getSession('embedder')]);
  const outputs = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]),
  });
  return l2Normalize(Float32Array.from(outputs[session.outputNames[0]].data as Float32Array));
}

export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

/** Cosine similarity, -1–1. Embeddings from `embed` are unit length, but this does not assume it. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error('cosine: vectors differ in length');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
