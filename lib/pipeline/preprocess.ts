import type { TemplateAnalysis } from '../ai/schemas';
import type { Upload } from '../db/schema';
import { AppError } from '../errors';
import { cosine } from '../face/arcface';
import { MISMATCH_COSINE } from '../limits';
import type { JobNotice } from '../types';

/**
 * Job-time choice of which user photos to send (Assumption 6). Photos that hide the face are
 * excluded, then photos whose identity embedding is far from the others. The best remaining photo
 * by `quality_score` is the reference. If nothing remains, the highest-quality photo is kept.
 */

/** Occlusions that hide identity. Hats and shadows still leave the face usable. */
const BLOCKING_OCCLUSIONS = {
  sunglasses: "you're wearing sunglasses",
  mask: 'your face is covered',
  hand_over_face: 'a hand covers your face',
} as const;
type BlockingOcclusion = keyof typeof BLOCKING_OCCLUSIONS;

export type ReferenceSelection = {
  referenceId: string;
  /** Photos to send, reference first, then in upload order. */
  usedIds: string[];
  notices: JobNotice[];
};

function blockingOcclusion(analysis: TemplateAnalysis, photoNumber: number): BlockingOcclusion | null {
  const photo = analysis.user.photos.find((p) => p.index === photoNumber);
  const hit = photo?.occlusions.find((o): o is BlockingOcclusion => o in BLOCKING_OCCLUSIONS);
  return hit ?? null;
}

function meanVector(vectors: number[][]): number[] {
  const mean = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) mean[i] += v[i] / vectors.length;
  return mean;
}

const byQualityDesc = (a: Upload, b: Upload) => (b.qualityScore ?? -Infinity) - (a.qualityScore ?? -Infinity);

/** `userPhotos` must be in the order they were sent to the analysis ("User photo 1" first). */
export function selectReference(userPhotos: Upload[], analysis: TemplateAnalysis): ReferenceSelection {
  if (userPhotos.length === 0) throw new AppError('VALIDATION_FAILED', { detail: 'selectReference: no user photos' });

  const numberOf = new Map(userPhotos.map((p, i) => [p.id, i + 1]));
  const excluded = new Map<string, JobNotice>();

  for (const photo of userPhotos) {
    const n = numberOf.get(photo.id)!;
    const occlusion = blockingOcclusion(analysis, n);
    if (occlusion) excluded.set(photo.id, { code: 'PHOTO_EXCLUDED_OCCLUSION', params: { n, reason: BLOCKING_OCCLUSIONS[occlusion] } });
  }

  // Compare each unoccluded photo with the mean of the other unoccluded ones. A sunglasses photo is
  // a noisy comparison point, so it does not take part.
  const comparable = userPhotos.filter((p) => !excluded.has(p.id) && p.embedding?.length);
  if (comparable.length >= 2) {
    for (const photo of comparable) {
      const others = comparable.filter((p) => p.id !== photo.id).map((p) => p.embedding!);
      if (cosine(photo.embedding!, meanVector(others)) < MISMATCH_COSINE) {
        excluded.set(photo.id, { code: 'PHOTO_EXCLUDED_MISMATCH', params: { n: numberOf.get(photo.id)! } });
      }
    }
  }

  const remaining = userPhotos.filter((p) => !excluded.has(p.id));
  if (remaining.length === 0) {
    const kept = [...userPhotos].sort(byQualityDesc)[0];
    excluded.delete(kept.id);
    return {
      referenceId: kept.id,
      usedIds: [kept.id],
      notices: [...excluded.values(), { code: 'ALL_PHOTOS_WEAK' }],
    };
  }

  const reference = [...remaining].sort(byQualityDesc)[0];
  return {
    referenceId: reference.id,
    usedIds: [reference.id, ...remaining.filter((p) => p.id !== reference.id).map((p) => p.id)],
    notices: userPhotos.flatMap((p) => excluded.get(p.id) ?? []),
  };
}
