'use client';

import type { FaceDetector } from '@mediapipe/tasks-vision';
import { FACE_MIN_SCORE, NORMALIZE_LONG_EDGE } from '../limits';
import type { Face } from '../types';
import { checkUserFaces } from './quality';

/**
 * Instant, advisory face check in the browser (MediaPipe BlazeFace, self-hosted under /models/mediapipe).
 * It applies the same face rules as the server, so green here usually stays green. The server check
 * in `normalizeUpload` is the one that counts.
 */

const WASM_BASE = '/models/mediapipe';
const MODEL_PATH = '/models/mediapipe/blaze_face_short_range.tflite';

let detector: Promise<FaceDetector | null> | null = null;

/** Loads the library, wasm and model once, on first use. Resolves null if any of it fails. */
function getDetector(): Promise<FaceDetector | null> {
  detector ??= import('@mediapipe/tasks-vision')
    .then(async ({ FaceDetector, FilesetResolver }) => {
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      return FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_PATH },
        runningMode: 'IMAGE',
        minDetectionConfidence: FACE_MIN_SCORE,
      });
    })
    .catch((err: unknown) => {
      console.warn('[face] live check unavailable', err);
      return null;
    });
  return detector;
}

/**
 * 'ok' when the photo shows exactly one clear, large enough face; 'warn' when the server will likely reject it;
 * null when the check can't run (no WebAssembly, assets missing, undecodable image).
 */
export async function liveCheck(image: ImageBitmap): Promise<'ok' | 'warn' | null> {
  const faceDetector = await getDetector();
  if (!faceDetector) return null;
  try {
    const { detections } = faceDetector.detect(image);
    // Measure faces at the size the server checks them, so the pixel thresholds mean the same thing.
    const scale = Math.min(1, NORMALIZE_LONG_EDGE / Math.max(image.width, image.height));
    const faces: Face[] = detections.flatMap(({ boundingBox: b, categories }) =>
      b
        ? [
            {
              box: [b.originX * scale, b.originY * scale, b.width * scale, b.height * scale],
              score: categories[0]?.score ?? 0,
              landmarks: [],
            },
          ]
        : [],
    );
    return checkUserFaces(faces, image.width * scale, image.height * scale).ok ? 'ok' : 'warn';
  } catch (err) {
    console.warn('[face] live check failed', err);
    return null;
  }
}
