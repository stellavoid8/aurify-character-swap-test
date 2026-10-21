/**
 * Fetches the face models the app runs locally:
 *   /models/det_500m.onnx, /models/w600k_mbf.onnx          (from InsightFace's buffalo_s.zip)
 *   /public/models/mediapipe/blaze_face_short_range.tflite  (browser face check)
 *   /public/models/mediapipe/*.wasm|.js                     (copied from @mediapipe/tasks-vision)
 * Downloads are checked against the SHA-256 hashes below; files already present are hashed and kept.
 * A hash left as null is printed instead of checked, so a new pin can be recorded.
 * Runs on `npm install` (postinstall) and before `next build` (prebuild).
 */
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const MODELS_DIR = path.join(ROOT, 'models');
const MEDIAPIPE_DIR = path.join(ROOT, 'public', 'models', 'mediapipe');
const MEDIAPIPE_WASM = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DOWNLOAD_TIMEOUT_MS = 120_000;

const BUFFALO_S = {
  url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip',
  sha256: 'd85a87f503f691807cd8bb97128bdf7a0660326cd9cd02657127fa978bab8b5e' as string | null,
  /** Zip entry name → file in /models. */
  extract: {
    'det_500m.onnx': { sha256: '5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a' as string | null },
    'w600k_mbf.onnx': { sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f' as string | null },
  },
};

const BLAZE_FACE = {
  url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  file: 'blaze_face_short_range.tflite',
  sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f' as string | null,
};

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function verify(label: string, buf: Buffer, expected: string | null): void {
  const actual = sha256(buf);
  if (expected === null) {
    console.log(`[models] ${label} sha256 ${actual} (no pin recorded yet: add it to scripts/fetch-models.ts)`);
  } else if (actual !== expected) {
    throw new Error(`${label}: sha256 mismatch (expected ${expected}, got ${actual})`);
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** True when `file` exists and matches its pin (or has none). A mismatching file is deleted so it is fetched again. */
async function existingIsGood(file: string, label: string, expected: string | null): Promise<boolean> {
  if (!existsSync(file)) return false;
  try {
    verify(label, await readFile(file), expected);
    return true;
  } catch (err) {
    console.warn(`[models] ${(err as Error).message}; downloading again`);
    await rm(file);
    return false;
  }
}

async function fetchBuffaloS(): Promise<void> {
  const entries = Object.entries(BUFFALO_S.extract);
  const missing = [];
  for (const [name, { sha256: pin }] of entries) {
    if (!(await existingIsGood(path.join(MODELS_DIR, name), name, pin))) missing.push(name);
  }
  if (missing.length === 0) return console.log('[models] InsightFace models present');

  console.log(`[models] downloading ${BUFFALO_S.url}`);
  const zipBuf = await download(BUFFALO_S.url);
  verify('buffalo_s.zip', zipBuf, BUFFALO_S.sha256);
  // Extract in a scratch directory first, so a bad hash never leaves a file in /models.
  const scratch = await mkdtemp(path.join(tmpdir(), 'cs-models-'));
  try {
    const zip = new AdmZip(zipBuf);
    for (const name of missing) {
      // Look entries up by base name: the archive may or may not nest them in a folder.
      const entry = zip.getEntries().find((e) => !e.isDirectory && path.posix.basename(e.entryName) === name);
      if (!entry) throw new Error(`buffalo_s.zip has no ${name}`);
      const data = entry.getData();
      verify(name, data, BUFFALO_S.extract[name as keyof typeof BUFFALO_S.extract].sha256);
      await writeFile(path.join(scratch, name), data);
    }
    await mkdir(MODELS_DIR, { recursive: true });
    for (const name of missing) await copyFile(path.join(scratch, name), path.join(MODELS_DIR, name));
    console.log(`[models] wrote ${missing.join(', ')} to /models`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function fetchBlazeFace(): Promise<void> {
  const target = path.join(MEDIAPIPE_DIR, BLAZE_FACE.file);
  if (await existingIsGood(target, BLAZE_FACE.file, BLAZE_FACE.sha256)) return console.log('[models] MediaPipe model present');
  console.log(`[models] downloading ${BLAZE_FACE.url}`);
  const data = await download(BLAZE_FACE.url);
  verify(BLAZE_FACE.file, data, BLAZE_FACE.sha256);
  await mkdir(MEDIAPIPE_DIR, { recursive: true });
  await writeFile(target, data);
}

/** The wasm runtime ships in the npm package (pinned by package-lock), so it is copied rather than downloaded. */
async function copyMediapipeWasm(): Promise<void> {
  if (!existsSync(MEDIAPIPE_WASM)) throw new Error('@mediapipe/tasks-vision is not installed');
  await mkdir(MEDIAPIPE_DIR, { recursive: true });
  const files = await readdir(MEDIAPIPE_WASM);
  let copied = 0;
  for (const file of files) {
    const target = path.join(MEDIAPIPE_DIR, file);
    if (existsSync(target)) {
      const [a, b] = await Promise.all([readFile(path.join(MEDIAPIPE_WASM, file)), readFile(target)]);
      if (a.equals(b)) continue;
    }
    await copyFile(path.join(MEDIAPIPE_WASM, file), target);
    copied++;
  }
  console.log(`[models] MediaPipe wasm: ${copied} of ${files.length} files copied`);
}

async function main() {
  await fetchBuffaloS();
  await fetchBlazeFace();
  await copyMediapipeWasm();
}

main().catch((err) => {
  console.error(`[models] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
