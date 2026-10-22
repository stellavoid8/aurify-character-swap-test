/**
 * Prints, per photo, how many faces the detector finds and how usable the main one is: its height as a
 * share of the image, frontalness (1 = camera-facing) and detector score. Used to vet bake-off templates.
 *   npx tsx scripts/face-check.ts bakeoff/images/*.jpg
 * Needs /models (scripts/fetch-models.ts). Inputs go through the same normalization as uploads.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { onnxModelsPresent } from '../lib/face/onnx';
import { frontalness, pickSubjectFace } from '../lib/face/quality';
import { detectFaces } from '../lib/face/scrfd';
import { FACE_MIN_SCORE, NORMALIZE_LONG_EDGE } from '../lib/limits';

async function check(file: string) {
  const { data, info } = await sharp(await readFile(file))
    .rotate()
    .resize(NORMALIZE_LONG_EDGE, NORMALIZE_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = { data: new Uint8Array(data), width: info.width, height: info.height };
  const faces = await detectFaces(rgb);
  const confident = faces.filter((f) => f.score >= FACE_MIN_SCORE);
  const index = pickSubjectFace(faces, rgb.width, rgb.height);
  const subject = index === null ? null : faces[index];
  return {
    file: path.basename(file),
    faces: confident.length,
    faceHeightPct: subject ? ((subject.box[3] / rgb.height) * 100).toFixed(1) : '-',
    frontal: subject ? frontalness(subject.landmarks).toFixed(2) : '-',
    score: subject ? subject.score.toFixed(2) : '-',
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: npx tsx scripts/face-check.ts <image>...');
    process.exit(2);
  }
  if (!onnxModelsPresent()) {
    console.error('Model files missing from /models. Run: npx tsx scripts/fetch-models.ts');
    process.exit(1);
  }
  const rows = [];
  for (const file of files) rows.push(await check(file));
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
