import { existsSync } from 'node:fs';
import path from 'node:path';
import type { InferenceSession } from 'onnxruntime-node';

/**
 * Lazy, process-wide ONNX Runtime sessions, one per model file.
 * onnxruntime-node is imported on first use, so the mock engine never loads the native binary.
 */

export const MODELS_DIR = path.join(process.cwd(), 'models');

export const FACE_MODELS = {
  detector: { file: 'det_500m.onnx', name: 'scrfd-500m' },
  embedder: { file: 'w600k_mbf.onnx', name: 'arcface-w600k-mbf' },
} as const;
export type FaceModel = keyof typeof FACE_MODELS;

export const modelPath = (model: FaceModel) => path.join(MODELS_DIR, FACE_MODELS[model].file);

export function onnxModelsPresent(): boolean {
  return (Object.keys(FACE_MODELS) as FaceModel[]).every((model) => existsSync(modelPath(model)));
}

export type Ort = typeof import('onnxruntime-node');

// Cached on globalThis so dev hot reloads and repeated route imports reuse one session per model.
const cache = globalThis as unknown as {
  __csOrt?: Promise<Ort>;
  __csFaceSessions?: Partial<Record<FaceModel, Promise<InferenceSession>>>;
};

export function loadOrt(): Promise<Ort> {
  cache.__csOrt ??= import('onnxruntime-node');
  return cache.__csOrt;
}

export function getSession(model: FaceModel): Promise<InferenceSession> {
  const sessions = (cache.__csFaceSessions ??= {});
  const existing = sessions[model];
  if (existing) return existing;
  const created = loadOrt().then((ort) =>
    ort.InferenceSession.create(modelPath(model), { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }),
  );
  // A failed load is not cached, so the next call retries instead of failing forever.
  created.catch(() => {
    if (sessions[model] === created) delete sessions[model];
  });
  sessions[model] = created;
  return created;
}
