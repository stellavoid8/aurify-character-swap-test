import { describe, expect, it } from 'vitest';
import type { Occlusion as OcclusionSchema } from '@/lib/ai/schemas';
import type { z } from 'zod';
import type { Upload } from '@/lib/db/schema';
import { selectReference } from '@/lib/pipeline/preprocess';
import { makeAnalysis } from './helpers/analysis';

type Occ = z.infer<typeof OcclusionSchema>[];

/** A unit vector along axis `axis` plus `noise` on the next axis: same axis = same person. */
function vec(axis: number, noise = 0.1): number[] {
  const v = new Array<number>(512).fill(0);
  v[axis] = 1;
  v[axis + 1] = noise;
  return v;
}

function photo(id: string, qualityScore: number | null, embedding: number[] | null = vec(0)): Upload {
  return {
    id,
    sessionId: '00000000-0000-4000-8000-000000000000',
    kind: 'user',
    status: 'ok',
    rejectCode: null,
    rawUrl: `https://example.test/${id}-raw.jpg`,
    url: `https://example.test/${id}.jpg`,
    width: 1000,
    height: 1000,
    bytes: 1,
    faces: [],
    subjectFaceIndex: null,
    qualityScore,
    embedding,
    createdAt: new Date(),
    deletedAt: null,
  };
}

function analysisWith(occlusions: Occ[]) {
  return makeAnalysis({ user: { photos: occlusions.map((o, i) => ({ index: i + 1, occlusions: o })) } });
}

describe('selectReference', () => {
  it('picks the highest-quality photo and keeps the rest in upload order', () => {
    const photos = [photo('a', 0.2), photo('b', 0.6), photo('c', 0.4)];
    const result = selectReference(photos, analysisWith([['none'], ['none'], ['none']]));
    expect(result).toEqual({ referenceId: 'b', usedIds: ['b', 'a', 'c'], notices: [] });
  });

  it('excludes a sunglasses photo even when it has the highest quality', () => {
    const photos = [photo('a', 0.3), photo('b', 0.9), photo('c', 0.5)];
    const result = selectReference(photos, analysisWith([['none'], ['sunglasses'], ['hat']]));
    expect(result.referenceId).toBe('c');
    expect(result.usedIds).toEqual(['c', 'a']);
    expect(result.notices).toEqual([{ code: 'PHOTO_EXCLUDED_OCCLUSION', params: { n: 2, reason: "you're wearing sunglasses" } }]);
  });

  it('does not exclude hats or heavy shadow', () => {
    const photos = [photo('a', 0.3), photo('b', 0.9)];
    const result = selectReference(photos, analysisWith([['hat'], ['heavy_shadow']]));
    expect(result).toEqual({ referenceId: 'b', usedIds: ['b', 'a'], notices: [] });
  });

  it('excludes an outlier embedding with PHOTO_EXCLUDED_MISMATCH', () => {
    const photos = [photo('a', 0.5), photo('b', 0.4, vec(0, 0.2)), photo('c', 0.9, vec(100)), photo('d', 0.3)];
    const result = selectReference(photos, analysisWith([['none'], ['none'], ['none'], ['none']]));
    expect(result.referenceId).toBe('a');
    expect(result.usedIds).toEqual(['a', 'b', 'd']);
    expect(result.notices).toEqual([{ code: 'PHOTO_EXCLUDED_MISMATCH', params: { n: 3 } }]);
  });

  it('skips the mismatch check for photos without an embedding', () => {
    const photos = [photo('a', 0.5, null), photo('b', 0.4)];
    const result = selectReference(photos, analysisWith([['none'], ['none']]));
    expect(result).toEqual({ referenceId: 'a', usedIds: ['a', 'b'], notices: [] });
  });

  it('all excluded: keeps the highest-quality photo and adds ALL_PHOTOS_WEAK', () => {
    const photos = [photo('a', 0.2), photo('b', 0.7), photo('c', 0.5)];
    const result = selectReference(photos, analysisWith([['sunglasses'], ['mask'], ['hand_over_face']]));
    expect(result.referenceId).toBe('b');
    expect(result.usedIds).toEqual(['b']);
    expect(result.notices).toEqual([
      { code: 'PHOTO_EXCLUDED_OCCLUSION', params: { n: 1, reason: "you're wearing sunglasses" } },
      { code: 'PHOTO_EXCLUDED_OCCLUSION', params: { n: 3, reason: 'a hand covers your face' } },
      { code: 'ALL_PHOTOS_WEAK' },
    ]);
  });

  it('two photos of different people both mismatch, so the clearer one is kept', () => {
    const photos = [photo('a', 0.2, vec(0)), photo('b', 0.8, vec(200))];
    const result = selectReference(photos, analysisWith([['none'], ['none']]));
    expect(result.usedIds).toEqual(['b']);
    expect(result.notices).toEqual([{ code: 'PHOTO_EXCLUDED_MISMATCH', params: { n: 1 } }, { code: 'ALL_PHOTOS_WEAK' }]);
  });
});
