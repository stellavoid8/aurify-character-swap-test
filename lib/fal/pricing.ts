import type { AnimationResolution, FalModel } from './models';

/**
 * Price per output image, read from fal.ai on 2026-10-21 (fal.ai/pricing and each model page).
 * fal notes the price is "one output at the model's default size"; larger sizes may cost more.
 */
export const FAL_PRICES: Record<FalModel, { perImageUsdMicros: number }> = {
  'fal-ai/nano-banana-pro/edit': { perImageUsdMicros: 150_000 }, // $0.15 (fal.ai/pricing)
  'fal-ai/bytedance/seedream/v4.5/edit': { perImageUsdMicros: 40_000 }, // $0.04 (fal.ai/pricing)
  'fal-ai/flux-pro/kontext/max/multi': { perImageUsdMicros: 80_000 }, // $0.08 (model page)
  // TODO: fal lists no per-output price for face-swap (GPU-time billed). Estimate; replace with the
  // cost shown on the fal dashboard after the first real refinement.
  'fal-ai/face-swap': { perImageUsdMicros: 10_000 },
};

export function falCostMicros(model: FalModel, imageCount: number): number {
  return FAL_PRICES[model].perImageUsdMicros * imageCount;
}

/**
 * VIDEO_MODEL bills per frame: 16 frames are one "video second". Read from its fal page on 2026-10-23.
 * Cost = frames ÷ 16 × the price for the output resolution.
 */
export const VIDEO_PRICES: Record<AnimationResolution, { perVideoSecondUsdMicros: number }> = {
  '480p': { perVideoSecondUsdMicros: 40_000 },
  '580p': { perVideoSecondUsdMicros: 60_000 },
  '720p': { perVideoSecondUsdMicros: 80_000 },
};
export const VIDEO_FRAMES_PER_BILLED_SECOND = 16;

export function falVideoCostMicros(frames: number, resolution: AnimationResolution): number {
  return Math.round((frames / VIDEO_FRAMES_PER_BILLED_SECOND) * VIDEO_PRICES[resolution].perVideoSecondUsdMicros);
}

// TODO: the ffmpeg endpoints bill compute time ($0 for metadata and merge, about $0.0002/s for
// extract-frame). Estimate per call; replace with the fal dashboard figure after real use.
export const UTILITY_CALL_USD_MICROS = 500;
