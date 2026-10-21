import type { FalModel } from './models';

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
