/**
 * fal model ids and the per-model input/output mapping. Model ids appear nowhere else in the app.
 * Endpoint ids and input field names were checked against each model's fal API page on 2026-10-21.
 */

export const GENERATOR_CANDIDATES = [
  'fal-ai/nano-banana-pro/edit',
  'fal-ai/bytedance/seedream/v4.5/edit',
  'fal-ai/flux-pro/kontext/max/multi',
] as const;

export const REFINE_MODEL = 'fal-ai/face-swap';

export type GeneratorModel = (typeof GENERATOR_CANDIDATES)[number];
export type FalModel = GeneratorModel | typeof REFINE_MODEL;

/** Replaced by the bake-off winner (prompt 8). */
export const PRIMARY_GENERATOR: GeneratorModel = GENERATOR_CANDIDATES[0];

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
