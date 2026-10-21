import { describe, expect, it } from 'vitest';
import {
  ARCFACE_TEMPLATE,
  alignFace,
  applyAffine,
  estimateSimilarity,
  invertAffine,
  warpAffine,
  type Affine,
} from '@/lib/face/align';

function expectMatrix(actual: Affine, expected: Affine, tolerance: number) {
  actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(tolerance));
}

describe('estimateSimilarity', () => {
  it('maps the template onto itself with the identity', () => {
    expectMatrix(estimateSimilarity(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE), [1, 0, 0, 0, 1, 0], 1e-9);
  });

  it('recovers a rotated, scaled and shifted copy within 1e-3', () => {
    const angle = (23 * Math.PI) / 180;
    const scale = 2.7;
    const truth: Affine = [
      scale * Math.cos(angle),
      -scale * Math.sin(angle),
      140.5,
      scale * Math.sin(angle),
      scale * Math.cos(angle),
      -32.25,
    ];
    const moved = ARCFACE_TEMPLATE.map((p) => applyAffine(truth, p));
    // Template → moved gives the transform itself; moved → template gives its inverse.
    expectMatrix(estimateSimilarity(ARCFACE_TEMPLATE, moved), truth, 1e-3);
    expectMatrix(estimateSimilarity(moved, ARCFACE_TEMPLATE), invertAffine(truth), 1e-3);
  });

  it('rejects degenerate input', () => {
    expect(() => estimateSimilarity([[1, 1], [1, 1]], [[0, 0], [1, 1]])).toThrow();
    expect(() => estimateSimilarity([[0, 0]], [[0, 0]])).toThrow();
  });
});

describe('warpAffine', () => {
  // 4×4 RGB gradient: value encodes position so resampling is easy to check.
  const src = {
    width: 4,
    height: 4,
    data: Uint8Array.from({ length: 48 }, (_, i) => {
      const px = Math.floor(i / 3);
      return (px % 4) * 10 + Math.floor(px / 4) * 50;
    }),
  };

  it('copies pixels unchanged under the identity', () => {
    expect(warpAffine(src, [1, 0, 0, 0, 1, 0], 4, 4).data).toEqual(src.data);
  });

  it('interpolates bilinearly between pixels', () => {
    // Shift by half a pixel: each output pixel averages two horizontal neighbours.
    const out = warpAffine(src, [1, 0, -0.5, 0, 1, 0], 3, 1);
    expect(Array.from(out.data.filter((_, i) => i % 3 === 0))).toEqual([5, 15, 25]);
  });

  it('fills samples outside the source with black', () => {
    const out = warpAffine(src, [1, 0, 10, 0, 1, 10], 2, 2);
    expect(out.data.every((v) => v === 0)).toBe(true);
  });
});

describe('alignFace', () => {
  it('returns a 112×112 crop', () => {
    const rgb = { width: 200, height: 200, data: new Uint8Array(200 * 200 * 3).fill(128) };
    const landmarks = ARCFACE_TEMPLATE.map(([x, y]) => [x + 40, y + 40] as [number, number]);
    const out = alignFace(rgb, landmarks);
    expect([out.width, out.height, out.data.length]).toEqual([112, 112, 112 * 112 * 3]);
    expect(out.data[56 * 112 * 3]).toBe(128);
  });
});
