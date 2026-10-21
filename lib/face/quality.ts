import { FACE_MIN_AREA_FRAC, FACE_MIN_SCORE, FACE_MIN_SIDE_FRAC, FACE_MIN_SIDE_PX } from '../limits';
import type { Face } from '../types';

/**
 * Rules for which detected faces count, and how good a face is to work from.
 * Every function takes faces in pixel coordinates of a `w`×`h` image.
 */

export type UserFaceCheck =
  | { ok: true; face: Face }
  | { ok: false; code: 'NO_FACE' | 'MULTIPLE_FACES' | 'FACE_TOO_SMALL' };

const areaFrac = (face: Face, w: number, h: number) => (face.box[2] * face.box[3]) / (w * h);

/**
 * 1 for a level, camera-facing face, falling toward 0 with head tilt (the eye line's roll) and with
 * head turn (how far the nose sits sideways from the eye midpoint, in half eye-distances).
 */
export function frontalness(landmarks: [number, number][]): number {
  const [[lx, ly], [rx, ry], [nx, ny]] = landmarks;
  const ex = rx - lx, ey = ry - ly;
  const eyeDist = Math.hypot(ex, ey);
  if (eyeDist === 0) return 0;
  // abs(): a strongly turned head can put the eyes in either order.
  const roll = Math.abs(Math.atan2(ey, Math.abs(ex)));
  const rollFactor = Math.max(0, 1 - roll / (Math.PI / 4));
  // Nose offset along the eye line, so a tilted but frontal face is not also counted as turned.
  const along = ((nx - (lx + rx) / 2) * ex + (ny - (ly + ry) / 2) * ey) / eyeDist;
  const yawFactor = Math.max(0, 1 - Math.abs(along) / (eyeDist / 2));
  return rollFactor * yawFactor;
}

/** Higher is a better face to work from: large, frontal and confidently detected. 0–1. */
export function qualityScore(face: Face, imgW: number, imgH: number): number {
  return areaFrac(face, imgW, imgH) * frontalness(face.landmarks) * face.score;
}

/**
 * A user photo must show exactly one clear face, large enough to carry their likeness.
 * Confident faces under FACE_MIN_AREA_FRAC are background people: they never cause MULTIPLE_FACES.
 */
export function checkUserFaces(faces: Face[], w: number, h: number): UserFaceCheck {
  const confident = faces.filter((f) => f.score >= FACE_MIN_SCORE);
  if (confident.length === 0) return { ok: false, code: 'NO_FACE' };
  const largeEnough = confident.filter((f) => areaFrac(f, w, h) >= FACE_MIN_AREA_FRAC);
  if (largeEnough.length > 1) return { ok: false, code: 'MULTIPLE_FACES' };
  // Only small faces: the user is in the photo, just too far away.
  if (largeEnough.length === 0) return { ok: false, code: 'FACE_TOO_SMALL' };

  const face = largeEnough[0];
  const side = Math.min(face.box[2], face.box[3]);
  if (side < FACE_MIN_SIDE_PX || side < FACE_MIN_SIDE_FRAC * Math.min(w, h)) return { ok: false, code: 'FACE_TOO_SMALL' };
  return { ok: true, face };
}

/** The template's main subject: the best-quality confident face, or null if there is none. */
export function pickSubjectFace(faces: Face[], w: number, h: number): number | null {
  let best: number | null = null;
  let bestKey: [number, number] = [-1, -1];
  faces.forEach((face, i) => {
    if (face.score < FACE_MIN_SCORE) return;
    // Area breaks ties, e.g. between two faces both in full profile (frontalness 0).
    const key: [number, number] = [qualityScore(face, w, h), areaFrac(face, w, h)];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = i;
      bestKey = key;
    }
  });
  return best;
}
