import { describe, expect, it } from 'vitest';
import { ARCFACE_SIZE, ARCFACE_TEMPLATE } from '@/lib/face/align';
import { checkUserFaces, frontalness, pickSubjectFace, qualityScore } from '@/lib/face/quality';
import type { Face } from '@/lib/types';

const W = 1000;
const H = 1000;

/** A frontal face whose box covers `areaFrac` of the W×H image, top-left at (x, y). */
function face(areaFrac: number, x = 100, y = 100, score = 0.9): Face {
  const side = Math.sqrt(areaFrac * W * H);
  return {
    box: [x, y, side, side],
    score,
    landmarks: ARCFACE_TEMPLATE.map(([lx, ly]) => [x + (lx / ARCFACE_SIZE) * side, y + (ly / ARCFACE_SIZE) * side]),
  };
}

describe('checkUserFaces', () => {
  it('NO_FACE when nothing confident is detected', () => {
    expect(checkUserFaces([], W, H)).toEqual({ ok: false, code: 'NO_FACE' });
    expect(checkUserFaces([face(0.2, 100, 100, 0.3)], W, H)).toEqual({ ok: false, code: 'NO_FACE' });
  });

  it('MULTIPLE_FACES when two faces are each ≥ 1.5% of the image', () => {
    expect(checkUserFaces([face(0.2, 0, 0), face(0.015, 600, 600)], W, H)).toEqual({ ok: false, code: 'MULTIPLE_FACES' });
  });

  it('FACE_TOO_SMALL when the only face is under the area limit', () => {
    expect(checkUserFaces([face(0.01)], W, H)).toEqual({ ok: false, code: 'FACE_TOO_SMALL' });
  });

  it('FACE_TOO_SMALL when the face is under the minimum side in pixels', () => {
    // 2% of a 300×300 image is a 42 px face: big enough by area, too few pixels to carry a likeness.
    const small = { ...face(0.02), box: [10, 10, 42, 42] as Face['box'] };
    expect(checkUserFaces([small], 300, 300)).toEqual({ ok: false, code: 'FACE_TOO_SMALL' });
  });

  it('ok with one clear face', () => {
    const one = face(0.2);
    expect(checkUserFaces([one], W, H)).toEqual({ ok: true, face: one });
  });

  it('ignores a 0.5%-area face in the background', () => {
    const main = face(0.2, 0, 0);
    expect(checkUserFaces([main, face(0.005, 800, 800)], W, H)).toEqual({ ok: true, face: main });
  });
});

describe('frontalness', () => {
  const frontal = ARCFACE_TEMPLATE;

  it('is close to 1 for the canonical frontal layout', () => {
    expect(frontalness(frontal)).toBeGreaterThan(0.95);
  });

  it('drops with head tilt and with head turn', () => {
    const tilt = (Math.PI / 180) * 20;
    const rotated = frontal.map(([x, y]) => [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt)] as [number, number]);
    const turned = frontal.map(([x, y], i) => (i === 2 ? [x + 12, y] : [x, y]) as [number, number]);
    expect(frontalness(rotated)).toBeLessThan(0.8);
    expect(frontalness(turned)).toBeLessThan(0.4);
  });

  it('does not count tilt as turn', () => {
    const tilt = (Math.PI / 180) * 20;
    const rotated = frontal.map(([x, y]) => [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt)] as [number, number]);
    expect(frontalness(rotated)).toBeCloseTo(1 - 20 / 45, 1);
  });

  it('is 0 when both eyes are at one point', () => {
    expect(frontalness([[1, 1], [1, 1], [1, 2], [0, 3], [2, 3]])).toBe(0);
  });
});

describe('qualityScore', () => {
  it('multiplies area fraction, frontalness and detector score', () => {
    const f = face(0.2, 100, 100, 0.8);
    expect(qualityScore(f, W, H)).toBeCloseTo(0.2 * frontalness(f.landmarks) * 0.8, 6);
  });
});

describe('pickSubjectFace', () => {
  it('picks the best-quality confident face', () => {
    expect(pickSubjectFace([face(0.02, 0, 0), face(0.1, 400, 400), face(0.3, 0, 500, 0.2)], W, H)).toBe(1);
  });

  it('returns null when no face is confident', () => {
    expect(pickSubjectFace([], W, H)).toBeNull();
    expect(pickSubjectFace([face(0.2, 0, 0, 0.1)], W, H)).toBeNull();
  });
});
