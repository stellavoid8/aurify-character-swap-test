/**
 * Video bake-off (Phase 0 of docs/decisions/0002-video-swap-architecture.md): runs each template clip
 * through VIDEO_MODEL once per driving image and resolution, then measures what the ADR leaves open:
 * whether 15 s works in one call, how likeness holds from the first to the last frame, render time,
 * cost, and whether the output keeps the clip's audio.
 *   npm run bakeoff:video
 * Reads bakeoff/video-pairs.json (shape: bakeoff/video-pairs.example.json; paths relative to bakeoff/).
 * Each pair has a clip, the user's reference selfie, and optionally `still`: a ranked result of the photo
 * pipeline on the clip's keyframe. Both drivers run, so "still beats selfie" is measured, not assumed.
 * Needs a real FAL_KEY and the ONNX face models. Inputs go to fal storage.
 *
 * Resume-safe: a cell whose bakeoff/out/video/<pair>__<driver>__<res>.json exists is not run again, so a
 * re-run makes no paid calls for finished cells. Delete the file to redo it.
 * Writes bakeoff/out/video/summary.md. Budget: 15 s at 720p is $1.80 per cell.
 */
import './load-env';
import './register-server-only';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { useMockFal } from '../lib/env';
import { cosine, faceEngine, pickSubjectFace } from '../lib/face';
import { runUtility, runVideoSync, uploadToFalStorage } from '../lib/fal/client';
import {
  buildAnimateInput,
  buildFrameInput,
  buildNormalizeInput,
  FFMPEG_EXTRACT_FRAME,
  FFMPEG_MERGE,
  FFMPEG_METADATA,
  normalizedSize,
  parseFrameOutput,
  parseNormalizeOutput,
  parseVideoMetadata,
  type AnimationResolution,
  type FrameType,
} from '../lib/fal/models';
import { falVideoCostMicros } from '../lib/fal/pricing';
import { normalizeImage } from '../lib/images';
import { MAX_VIDEO_SECONDS, VIDEO_MAX_LONG_EDGE, VIDEO_TARGET_FPS } from '../lib/limits';
import { formatUsd } from '../lib/money';
import { fetchObject } from '../lib/storage';

const BAKEOFF_DIR = path.join(process.cwd(), 'bakeoff');
const OUT_DIR = path.join(BAKEOFF_DIR, 'out', 'video');
const SEED = 42;
const RESOLUTIONS: AnimationResolution[] = ['580p', '720p'];
const FRAMES: FrameType[] = ['first', 'middle', 'last'];
/** Scripts may wait longer than a request: a 15 s re-encode on fal is not instant. */
const UTILITY_TIMEOUT_MS = 5 * 60_000;

const PairSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, { error: 'letters, digits, - and _ only' }),
  note: z.string(),
  clip: z.string(),
  selfie: z.string(),
  still: z.string().optional(),
});
type Pair = z.infer<typeof PairSchema>;
type Driver = 'selfie' | 'still';

type Cell = {
  pair: string;
  driver: Driver;
  resolution: AnimationResolution;
  status: 'ok' | 'failed';
  error?: string;
  clipSeconds: number;
  frames: number;
  costUsdMicros: number;
  renderMs: number;
  /** Likeness at the first, middle and last frame; null where no face was found. */
  identity: Partial<Record<FrameType, number | null>>;
  outputHasAudio: boolean | null;
  outputSeconds: number | null;
  videoUrl: string | null;
};

const cellFile = (pair: string, driver: Driver, res: string) => path.join(OUT_DIR, `${pair}__${driver}__${res}.json`);
const exists = (file: string) => access(file).then(() => true, () => false);
const utility = (model: Parameters<typeof runUtility>[0]['model'], input: Record<string, unknown>) =>
  runUtility({ model, input, timeoutMs: UTILITY_TIMEOUT_MS, context: { stage: 'bakeoff-video' } });

async function uploadLocal(relative: string, contentType: string): Promise<string> {
  return uploadToFalStorage(await readFile(path.join(BAKEOFF_DIR, relative)), contentType);
}

/** The reference embedding: the selfie's most prominent face. */
async function embed(jpegBytes: Buffer): Promise<number[]> {
  const { jpeg, width, height } = await normalizeImage(jpegBytes);
  const { faces } = await faceEngine.analyzeImage(jpeg);
  const index = pickSubjectFace(faces, width, height);
  if (index === null) throw new Error('no face in the selfie');
  return faceEngine.embedFace(jpeg, faces[index]);
}

/** Likeness of the most prominent face in one frame of the result. */
async function frameIdentity(videoUrl: string, frame: FrameType, reference: number[]): Promise<number | null> {
  const { imageUrl } = parseFrameOutput(await utility(FFMPEG_EXTRACT_FRAME, buildFrameInput({ videoUrl, frame })));
  if (!imageUrl) return null;
  const { jpeg, width, height } = await normalizeImage(await fetchObject(imageUrl));
  const { faces } = await faceEngine.analyzeImage(jpeg);
  const index = pickSubjectFace(faces, width, height);
  return index === null ? null : cosine(await faceEngine.embedFace(jpeg, faces[index]), reference);
}

/** The clip as production prepares it: probed, then re-encoded to VIDEO_TARGET_FPS and at most 720p. */
async function prepareClip(pair: Pair): Promise<{ url: string; seconds: number; frames: number }> {
  const raw = await uploadLocal(pair.clip, 'video/mp4');
  const meta = parseVideoMetadata(await utility(FFMPEG_METADATA, { media_url: raw }));
  if (meta.durationMs === null) throw new Error('probe has no duration');
  if (meta.durationMs > MAX_VIDEO_SECONDS * 1000 + 250) console.warn(`  ${pair.id}: clip is ${meta.durationMs} ms, over the app's limit`);
  const size = normalizedSize(meta.width, meta.height, VIDEO_MAX_LONG_EDGE);
  const { videoUrl } = parseNormalizeOutput(await utility(FFMPEG_MERGE, buildNormalizeInput({ videoUrl: raw, fps: VIDEO_TARGET_FPS, size })));
  if (!videoUrl) throw new Error('re-encode returned no video');
  const seconds = meta.durationMs / 1000;
  return { url: videoUrl, seconds, frames: Math.round(seconds * VIDEO_TARGET_FPS) };
}

async function runCell(pair: Pair, driver: Driver, resolution: AnimationResolution, clip: { url: string; seconds: number; frames: number }, reference: number[]): Promise<Cell> {
  const base = { pair: pair.id, driver, resolution, clipSeconds: clip.seconds, frames: clip.frames };
  try {
    const imageUrl = await uploadLocal(driver === 'still' ? pair.still! : pair.selfie, 'image/jpeg');
    const { videoUrl, latencyMs } = await runVideoSync({
      input: buildAnimateInput({ videoUrl: clip.url, imageUrl, seed: SEED, resolution }),
      frames: clip.frames,
      resolution,
      context: { stage: 'bakeoff-video' },
    });
    if (!videoUrl) throw new Error('no video in the output');
    const identity: Cell['identity'] = {};
    for (const frame of FRAMES) identity[frame] = await frameIdentity(videoUrl, frame, reference);
    const out = await utility(FFMPEG_METADATA, { media_url: videoUrl });
    const media = (out as { media?: { audio?: unknown; duration?: number } }).media;
    return {
      ...base,
      status: 'ok',
      costUsdMicros: falVideoCostMicros(clip.frames, resolution),
      renderMs: Math.round(latencyMs),
      identity,
      outputHasAudio: media ? media.audio != null : null,
      outputSeconds: media?.duration ?? null,
      videoUrl,
    };
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      costUsdMicros: 0,
      renderMs: 0,
      identity: {},
      outputHasAudio: null,
      outputSeconds: null,
      videoUrl: null,
    };
  }
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function summary(cells: Cell[]): string {
  const rows = cells.map((c) => {
    const scores = FRAMES.map((f) => c.identity[f]).filter((v): v is number => v != null);
    const min = scores.length > 0 ? Math.min(...scores) : null;
    return `| ${c.pair} | ${c.driver} | ${c.resolution} | ${c.clipSeconds.toFixed(1)} | ${c.frames} | ${formatUsd(c.costUsdMicros)} | ${(c.renderMs / 1000).toFixed(0)} | ${pct(c.identity.first)} | ${pct(c.identity.middle)} | ${pct(c.identity.last)} | ${pct(min)} | ${c.outputHasAudio ?? '—'} | ${c.outputSeconds ?? '—'} | ${c.status}${c.error ? `: ${c.error}` : ''} |`;
  });
  return [
    `# Video bake-off`,
    '',
    `Seed ${SEED}, clips re-encoded to ${VIDEO_TARGET_FPS} fps. Likeness is ArcFace cosine to the selfie at the first, middle and last frame.`,
    '',
    '| Pair | Driver | Res | Clip s | Frames | Cost | Render s | First | Middle | Last | Min | Audio kept | Out s | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function main() {
  if (useMockFal) throw new Error('The video bake-off needs a real FAL_KEY.');
  const pairs = z.array(PairSchema).parse(JSON.parse(await readFile(path.join(BAKEOFF_DIR, 'video-pairs.json'), 'utf8')));
  await mkdir(OUT_DIR, { recursive: true });

  const cells: Cell[] = [];
  for (const pair of pairs) {
    const drivers: Driver[] = pair.still ? ['selfie', 'still'] : ['selfie'];
    const todo = drivers.flatMap((d) => RESOLUTIONS.map((r) => [d, r] as const));
    const pending: (typeof todo)[number][] = [];
    for (const [d, r] of todo) {
      const file = cellFile(pair.id, d, r);
      if (await exists(file)) cells.push(JSON.parse(await readFile(file, 'utf8')) as Cell);
      else pending.push([d, r]);
    }
    if (pending.length === 0) continue;

    console.info(`${pair.id}: preparing clip`);
    const clip = await prepareClip(pair);
    const reference = await embed(await readFile(path.join(BAKEOFF_DIR, pair.selfie)));
    for (const [driver, resolution] of pending) {
      console.info(`${pair.id}: ${driver} @ ${resolution} (${formatUsd(falVideoCostMicros(clip.frames, resolution))})`);
      const cell = await runCell(pair, driver, resolution, clip, reference);
      if (cell.status === 'ok') await writeFile(cellFile(pair.id, driver, resolution), JSON.stringify(cell, null, 2));
      cells.push(cell);
    }
  }

  await writeFile(path.join(OUT_DIR, 'summary.md'), summary(cells));
  console.info(`Wrote ${path.relative(process.cwd(), path.join(OUT_DIR, 'summary.md'))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
