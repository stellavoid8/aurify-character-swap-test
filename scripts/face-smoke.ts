/**
 * Runs the real ONNX face pipeline on two photos and prints face counts, their likeness (cosine) and timings.
 *   npx tsx scripts/face-smoke.ts a.jpg b.jpg
 * Same person should score > 0.45, different people < 0.3. Needs /models (scripts/fetch-models.ts).
 * Inputs go through the same normalization as uploads, so EXIF rotation and sizing match the app.
 */
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ARCFACE_SIZE, alignFace } from '../lib/face/align';
import { cosine, embed } from '../lib/face/arcface';
import { onnxModelsPresent } from '../lib/face/onnx';
import { pickSubjectFace, qualityScore } from '../lib/face/quality';
import { detectFaces } from '../lib/face/scrfd';
import { NORMALIZE_LONG_EDGE } from '../lib/limits';
import type { RgbImage } from '../lib/types';

async function load(file: string): Promise<RgbImage> {
  const { data, info } = await sharp(await readFile(file))
    .rotate()
    .resize(NORMALIZE_LONG_EDGE, NORMALIZE_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

const ms = (start: number) => Math.round(performance.now() - start);

async function analyze(file: string) {
  const rgb = await load(file);
  let t = performance.now();
  const faces = await detectFaces(rgb);
  const detectMs = ms(t);
  const index = pickSubjectFace(faces, rgb.width, rgb.height);
  if (index === null) return { file, size: `${rgb.width}×${rgb.height}`, faces: faces.length, detectMs, embedding: null };
  t = performance.now();
  const embedding = await embed(alignFace(rgb, faces[index].landmarks));
  return {
    file,
    size: `${rgb.width}×${rgb.height}`,
    faces: faces.length,
    score: faces[index].score.toFixed(3),
    quality: qualityScore(faces[index], rgb.width, rgb.height).toFixed(3),
    detectMs,
    embedMs: ms(t),
    embedding,
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length !== 2) {
    console.error('usage: npx tsx scripts/face-smoke.ts a.jpg b.jpg');
    process.exit(2);
  }
  if (!onnxModelsPresent()) {
    console.error('Model files missing from /models. Run: npx tsx scripts/fetch-models.ts');
    process.exit(1);
  }

  // First pass includes session creation (cold); the second reuses it (warm).
  const cold = await analyze(files[0]);
  const results = [cold, await analyze(files[1]), await analyze(files[0])];
  for (const [label, r] of [['cold', results[0]], ['warm', results[1]], ['warm', results[2]]] as const) {
    const { embedding, ...shown } = r;
    console.log(label, { ...shown, embedded: embedding !== null, crop: `${ARCFACE_SIZE}×${ARCFACE_SIZE}` });
  }
  const [a, b] = results;
  if (a.embedding && b.embedding) console.log(`cosine ${cosine(a.embedding, b.embedding).toFixed(4)}`);
  else console.log('cosine n/a: no usable face in at least one photo');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
