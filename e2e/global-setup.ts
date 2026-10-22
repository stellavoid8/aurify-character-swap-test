import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_UPLOAD_BYTES } from '../lib/limits';
import { PHOTOS, SESSIONS_FILE, fixture } from './helpers/flow';

/** Writes the oversized photo (too big to commit) and starts the list of sessions to clean up. */
export default async function globalSetup(): Promise<void> {
  // A JPEG signature then zeros: the browser rejects it on size before anything reads the pixels.
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1024 * 1024);
  big.set([0xff, 0xd8, 0xff, 0xe0]);
  writeFileSync(fixture(PHOTOS.big), big);

  mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  writeFileSync(SESSIONS_FILE, '');
}
