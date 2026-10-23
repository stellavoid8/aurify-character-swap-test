/**
 * fal model ids and the per-model input/output mapping. Model ids appear nowhere else in the app.
 * Endpoint ids and input field names were checked against each model's fal API page on 2026-10-21.
 */
import type { SwapCase } from '../pipeline/cases';

export const GENERATOR_CANDIDATES = [
  'fal-ai/nano-banana-pro/edit',
  'fal-ai/bytedance/seedream/v4.5/edit',
  'fal-ai/flux-pro/kontext/max/multi',
] as const;

/** The name the result screen shows under each image. */
const GENERATOR_LABELS: Record<GeneratorModel, string> = {
  'fal-ai/nano-banana-pro/edit': 'Nano Banana Pro',
  'fal-ai/bytedance/seedream/v4.5/edit': 'Seedream 4.5',
  'fal-ai/flux-pro/kontext/max/multi': 'FLUX Kontext Max',
};

export const REFINE_MODEL = 'fal-ai/face-swap';

/** Video character replacement for animation rounds (docs/decisions/0002-video-swap-architecture.md). */
export const VIDEO_MODEL = 'fal-ai/wan/v2.2-14b/animate/replace';

/** fal's hosted ffmpeg, called synchronously through `runUtility`: no ffmpeg binary on Vercel. */
export const FFMPEG_METADATA = 'fal-ai/ffmpeg-api/metadata';
export const FFMPEG_MERGE = 'fal-ai/ffmpeg-api/merge-videos';
export const FFMPEG_EXTRACT_FRAME = 'fal-ai/ffmpeg-api/extract-frame';

export type GeneratorModel = (typeof GENERATOR_CANDIDATES)[number];
/** The image models: generators and face swap. */
export type FalModel = GeneratorModel | typeof REFINE_MODEL;
export type VideoModel = typeof VIDEO_MODEL;
/** Everything that goes through the fal queue with a webhook. */
export type QueueModel = FalModel | VideoModel;
export type UtilityModel = typeof FFMPEG_METADATA | typeof FFMPEG_MERGE | typeof FFMPEG_EXTRACT_FRAME;
export type AnimationResolution = '480p' | '580p' | '720p';
export type FrameType = 'first' | 'middle' | 'last';

/** Bake-off winner overall; the generator for cases the bake-off has no pair for. See docs/decisions/0001-generator.md. */
export const PRIMARY_GENERATOR: GeneratorModel = 'fal-ai/bytedance/seedream/v4.5/edit';

/**
 * Per-case bake-off winners (likeness, then a by-eye check), see docs/decisions/0001-generator.md.
 * Not used for routing: every round makes one image on each of GENERATOR_CANDIDATES.
 */
export const GENERATOR_BY_CASE: Record<SwapCase, GeneratorModel> = {
  case1: 'fal-ai/nano-banana-pro/edit',
  case2_m2f: 'fal-ai/bytedance/seedream/v4.5/edit',
  case2_f2m: 'fal-ai/bytedance/seedream/v4.5/edit',
  case3_a2c: 'fal-ai/bytedance/seedream/v4.5/edit',
  case3_c2a: 'fal-ai/bytedance/seedream/v4.5/edit',
  other: PRIMARY_GENERATOR,
};

/** A generator's display name; null for anything else (Fix the face and animation results). */
export function generatorLabel(model: string): string | null {
  return (GENERATOR_LABELS as Record<string, string>)[model] ?? null;
}

export type BuildInputArgs = {
  prompt: string;
  /**
   * Generators: `[template, reference, ...otherUserPhotos]`.
   * REFINE_MODEL: `[target (the chosen result), sourceFace (the reference photo)]`.
   */
  imageUrls: string[];
  seed?: number;
};

export function buildInput(model: FalModel, { prompt, imageUrls, seed }: BuildInputArgs): Record<string, unknown> {
  const seeded = seed === undefined ? {} : { seed };
  switch (model) {
    case 'fal-ai/nano-banana-pro/edit':
      return { prompt, image_urls: imageUrls, ...seeded, num_images: 1, output_format: 'jpeg' };
    case 'fal-ai/bytedance/seedream/v4.5/edit':
      // No output_format field on this endpoint; image_size picks the output size, auto keeps the input aspect.
      return { prompt, image_urls: imageUrls, ...seeded, num_images: 1, image_size: 'auto_2K' };
    case 'fal-ai/flux-pro/kontext/max/multi':
      // Kontext blends every input image; more than template + reference dilutes the scene.
      return { prompt, image_urls: imageUrls.slice(0, 2), ...seeded, num_images: 1, output_format: 'jpeg' };
    case 'fal-ai/face-swap': {
      const [target, sourceFace] = imageUrls;
      if (!target || !sourceFace) throw new Error('face-swap needs [target, sourceFace]');
      return { base_image_url: target, swap_image_url: sourceFace };
    }
  }
}

/** The face-swap input for Fix the face: the chosen result gets the face from the reference photo. */
export function buildRefineInput({ targetUrl, faceUrl }: { targetUrl: string; faceUrl: string }): Record<string, unknown> {
  return buildInput(REFINE_MODEL, { prompt: '', imageUrls: [targetUrl, faceUrl] });
}

/** Generators return `{ images: [{ url }] }`; face-swap returns `{ image: { url } }`. */
export function parseOutput(payload: unknown): { imageUrls: string[] } {
  if (!payload || typeof payload !== 'object') return { imageUrls: [] };
  const { images, image } = payload as { images?: unknown; image?: unknown };
  const list = Array.isArray(images) ? images : image ? [image] : [];
  const imageUrls = list
    .map((item) => (item && typeof item === 'object' ? (item as { url?: unknown }).url : undefined))
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
  return { imageUrls };
}

/** The replace model's input: the template clip with its subject swapped for the person in `imageUrl`. */
export function buildAnimateInput({
  videoUrl,
  imageUrl,
  seed,
  resolution,
}: {
  videoUrl: string;
  imageUrl: string;
  seed: number;
  resolution: AnimationResolution;
}): Record<string, unknown> {
  // Outputs are real people's faces in motion, so fal's output safety check stays on.
  return { video_url: videoUrl, image_url: imageUrl, seed, resolution, enable_output_safety_checker: true };
}

/** The replace model returns `{ video: { url } }`. */
export function parseVideoOutput(payload: unknown): { videoUrl: string | null } {
  const video = payload && typeof payload === 'object' ? (payload as { video?: unknown }).video : undefined;
  const url = video && typeof video === 'object' ? (video as { url?: unknown }).url : undefined;
  return { videoUrl: typeof url === 'string' && url.length > 0 ? url : null };
}

/**
 * Re-encodes one clip to `fps`, and to `size` when given: merge-videos with a one-item list.
 * fal accepts sizes with both sides from 512 to 2048 (see `normalizedSize`).
 */
export function buildNormalizeInput({
  videoUrl,
  fps,
  size,
}: {
  videoUrl: string;
  fps: number;
  size: { width: number; height: number } | null;
}): Record<string, unknown> {
  return { video_urls: [videoUrl], target_fps: fps, ...(size ? { resolution: size } : {}) };
}

/** Output size for a clip: long edge down to `longEdge`, even sides. Null keeps the source size (already small, or outside fal's range). */
export function normalizedSize(width: number | null, height: number | null, longEdge: number): { width: number; height: number } | null {
  if (!width || !height || Math.max(width, height) <= longEdge) return null;
  const scale = longEdge / Math.max(width, height);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const size = { width: even(width), height: even(height) };
  return Math.min(size.width, size.height) < 512 ? null : size;
}

export function buildFrameInput({ videoUrl, frame }: { videoUrl: string; frame: FrameType }): Record<string, unknown> {
  return { video_url: videoUrl, frame_type: frame };
}

/** What the probe says about a clip. Any field fal leaves out is null. */
export type VideoMetadata = {
  durationMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  frameCount: number | null;
};

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/**
 * Reads `{ media: Video }` from FFMPEG_METADATA: `duration` (s), `fps`, `frame_count` and
 * `resolution.{width,height}`, per fal's published endpoint types.
 */
export function parseVideoMetadata(payload: unknown): VideoMetadata {
  const media = payload && typeof payload === 'object' ? (payload as { media?: unknown }).media : undefined;
  const m = (media && typeof media === 'object' ? media : {}) as Record<string, unknown>;
  const resolution = (m.resolution && typeof m.resolution === 'object' ? m.resolution : {}) as Record<string, unknown>;
  const seconds = num(m.duration);
  return {
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    fps: num(m.fps),
    width: num(resolution.width),
    height: num(resolution.height),
    frameCount: num(m.frame_count),
  };
}

/** FFMPEG_MERGE returns `{ video: { url } }`, the same shape as the video model. */
export const parseNormalizeOutput = parseVideoOutput;

/** FFMPEG_EXTRACT_FRAME returns `{ images: [{ url }] }`. */
export function parseFrameOutput(payload: unknown): { imageUrl: string | null } {
  return { imageUrl: parseOutput(payload).imageUrls[0] ?? null };
}
