import type { RgbImage } from '../types';

/**
 * Face alignment for ArcFace: fit a similarity transform from the five detected landmarks onto
 * the canonical 112×112 template, then resample the face with it.
 * Pure math, no I/O, so it is safe anywhere (including tests).
 */

export const ARCFACE_SIZE = 112;

/** Where the five landmarks sit in a 112×112 ArcFace crop (insightface `arcface_dst`). */
export const ARCFACE_TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** 2×3 affine matrix, row-major: x' = m[0]x + m[1]y + m[2], y' = m[3]x + m[4]y + m[5]. */
export type Affine = [number, number, number, number, number, number];

/**
 * Least-squares similarity (rotation, uniform scale, translation) mapping `src` onto `dst`.
 * This is Umeyama's estimate without reflection; in 2D it has the closed form below.
 */
export function estimateSimilarity(src: [number, number][], dst: [number, number][]): Affine {
  if (src.length !== dst.length || src.length < 2) throw new Error('estimateSimilarity needs ≥ 2 matching points');
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;

  // With src and dst demeaned, the best [a -b; b a] is a = Σ(s·d) / Σ|s|², b = Σ(s×d) / Σ|s|².
  let dot = 0, cross = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy;
    const qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    norm += px * px + py * py;
  }
  if (norm === 0) throw new Error('estimateSimilarity: source points are all the same');
  const a = dot / norm;
  const b = cross / norm;
  return [a, -b, dx - (a * sx - b * sy), b, a, dy - (b * sx + a * sy)];
}

export function applyAffine(m: Affine, [x, y]: [number, number]): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[4] - m[1] * m[3];
  if (det === 0) throw new Error('invertAffine: matrix is singular');
  const i0 = m[4] / det, i1 = -m[1] / det, i3 = -m[3] / det, i4 = m[0] / det;
  return [i0, i1, -(i0 * m[2] + i1 * m[5]), i3, i4, -(i3 * m[2] + i4 * m[5])];
}

/**
 * Resamples `rgb` into a `width`×`height` image where output pixel p = M · (source pixel).
 * Bilinear; samples outside the source are black, as with cv2.warpAffine's default border.
 */
export function warpAffine(rgb: RgbImage, m: Affine, width: number, height: number): RgbImage {
  const inv = invertAffine(m);
  const out = new Uint8Array(width * height * 3);
  const { data, width: sw, height: sh } = rgb;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = inv[0] * x + inv[1] * y + inv[2];
      const srcY = inv[3] * x + inv[4] * y + inv[5];
      const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
      const fx = srcX - x0, fy = srcY - y0;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        // Four neighbours, each weighted by its share of the sample point.
        for (let k = 0; k < 4; k++) {
          const px = x0 + (k & 1), py = y0 + (k >> 1);
          if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
          const w = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
          acc += w * data[(py * sw + px) * 3 + c];
        }
        out[o + c] = Math.round(acc);
      }
    }
  }
  return { data: out, width, height };
}

/** The 112×112 ArcFace input for a face with five landmarks in `rgb`'s pixel coordinates. */
export function alignFace(rgb: RgbImage, landmarks: [number, number][]): RgbImage {
  return warpAffine(rgb, estimateSimilarity(landmarks, ARCFACE_TEMPLATE), ARCFACE_SIZE, ARCFACE_SIZE);
}
