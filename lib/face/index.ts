import 'server-only';
import sharp from 'sharp';
import { env } from '../env';
import { recordCall } from '../telemetry';
import type { Face, FaceBox, RgbImage } from '../types';
import { alignFace } from './align';
import { embed } from './arcface';
import { mockAnalyzeImage, mockEmbedFace } from './mock';
import { FACE_MODELS, onnxModelsPresent } from './onnx';
import { detectFaces } from './scrfd';

/**
 * The app's face engine: detection and identity embeddings, run locally in the Node function.
 * FACE_ENGINE=auto uses ONNX when both model files are in /models and the mock otherwise;
 * =onnx and =mock force one. Every call writes a `provider_calls` row (provider `local`, cost 0).
 */

export type FaceEngineName = 'onnx' | 'mock';

/** Links a face call to the job it ran for, for telemetry. */
export type FaceCallContext = { jobId?: string | null; roundId?: string | null; candidateId?: string | null; stage?: string };

export type FaceAnalysis = { faces: Face[]; width: number; height: number };

let resolved: FaceEngineName | null = null;

function resolveEngine(): FaceEngineName {
  if (resolved) return resolved;
  if (env.FACE_ENGINE !== 'auto') {
    resolved = env.FACE_ENGINE;
  } else if (onnxModelsPresent()) {
    resolved = 'onnx';
  } else {
    resolved = 'mock';
    console.warn('[face] model files not found in /models; using the mock face engine. Run `npx tsx scripts/fetch-models.ts`.');
  }
  return resolved;
}

export async function decodeRgb(jpeg: Buffer): Promise<RgbImage> {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

async function timed<T>(
  ctx: FaceCallContext,
  defaultStage: string,
  model: string,
  fn: () => Promise<T>,
  meta: (result: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const started = performance.now();
  const base = { jobId: ctx.jobId, roundId: ctx.roundId, candidateId: ctx.candidateId, provider: 'local' as const, model, stage: ctx.stage ?? defaultStage, costUsdMicros: 0 };
  try {
    const result = await fn();
    await recordCall({ ...base, status: 'ok', latencyMs: performance.now() - started, meta: meta(result) });
    return result;
  } catch (err) {
    await recordCall({ ...base, status: 'error', latencyMs: performance.now() - started, meta: { error: String(err) } });
    throw err;
  }
}

export const faceEngine = {
  get name(): FaceEngineName {
    return resolveEngine();
  },

  /** Every face in a normalized JPEG, in pixel coordinates, best first. */
  analyzeImage(jpeg: Buffer, ctx: FaceCallContext = {}): Promise<FaceAnalysis> {
    const engine = resolveEngine();
    const model = engine === 'onnx' ? FACE_MODELS.detector.name : 'mock-face';
    return timed(
      ctx,
      'face-detect',
      model,
      async () => {
        if (engine === 'mock') return mockAnalyzeImage(jpeg);
        const rgb = await decodeRgb(jpeg);
        return { faces: await detectFaces(rgb), width: rgb.width, height: rgb.height };
      },
      (result) => ({ faces: result.faces.length }),
    );
  },

  /** 512-d unit-length identity vector for one face (from `analyzeImage` on the same JPEG). */
  embedFace(jpeg: Buffer, face: Face, ctx: FaceCallContext = {}): Promise<number[]> {
    const engine = resolveEngine();
    const model = engine === 'onnx' ? FACE_MODELS.embedder.name : 'mock-face';
    return timed(ctx, 'face-embed', model, async () => {
      if (engine === 'mock') return mockEmbedFace(jpeg, face);
      return Array.from(await embed(alignFace(await decodeRgb(jpeg), face.landmarks)));
    });
  },
};

/** Pixel face → the normalized 0–1 shape stored in `uploads.faces`. */
export function toFaceBox(face: Face, width: number, height: number): FaceBox {
  const [x, y, w, h] = face.box;
  return {
    box: [x / width, y / height, w / width, h / height],
    score: face.score,
    landmarks: face.landmarks.map(([lx, ly]) => [lx / width, ly / height]),
  };
}

/** Stored normalized face → pixel coordinates of a `width`×`height` image. */
export function fromFaceBox(face: FaceBox, width: number, height: number): Face {
  const [x, y, w, h] = face.box;
  return {
    box: [x * width, y * height, w * width, h * height],
    score: face.score,
    landmarks: face.landmarks.map(([lx, ly]) => [lx * width, ly * height]),
  };
}

export { cosine } from './arcface';
export { checkUserFaces, frontalness, pickSubjectFace, qualityScore } from './quality';
