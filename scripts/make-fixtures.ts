/**
 * Writes the solid-colour photos that drive the mock face engine (lib/face/mock.ts) into
 * tests/fixtures/ and e2e/fixtures/: red → no face, blue → two faces, grey → one face.
 *   npx tsx scripts/make-fixtures.ts
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SIZE = { width: 640, height: 480 };

export const FACE_FIXTURES = {
  'face-none-red.jpg': { r: 220, g: 40, b: 40 },
  'face-two-blue.jpg': { r: 40, g: 60, b: 220 },
  'face-one-grey.jpg': { r: 150, g: 150, b: 150 },
} as const;

async function main() {
  for (const dir of ['tests/fixtures', 'e2e/fixtures']) {
    const target = path.join(process.cwd(), dir);
    await mkdir(target, { recursive: true });
    for (const [file, background] of Object.entries(FACE_FIXTURES)) {
      await sharp({ create: { ...SIZE, channels: 3, background } }).jpeg({ quality: 90 }).toFile(path.join(target, file));
    }
    console.log(`wrote ${Object.keys(FACE_FIXTURES).join(', ')} to ${dir}/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
