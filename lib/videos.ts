import 'server-only';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { useMockFal } from './env';
import { AppError } from './errors';
import { MAX_RESULT_VIDEO_BYTES, VIDEO_MAX_LONG_EDGE, VIDEO_TARGET_FPS, VIDEO_UTILITY_TIMEOUT_MS } from './limits';
import { fetchObject } from './storage';
import { recordCall } from './telemetry';

/**
 * Re-encodes a clip to VIDEO_TARGET_FPS with the long edge at most VIDEO_MAX_LONG_EDGE (H.264 + AAC, faststart mp4),
 * keeping its audio. Runs ffmpeg-static here: fal has no single-clip endpoint that sets the frame rate (merge-videos
 * needs two or more inputs), see docs/decisions/0002-video-swap-architecture.md §3.
 * ffmpeg reads `url` over HTTP itself, so a 200 MB raw upload is never held in memory. Failures throw
 * VIDEO_DECODE_FAILED, an output over MAX_RESULT_VIDEO_BYTES throws VIDEO_TOO_LARGE. Writes one `provider_calls` row.
 */
export async function normalizeVideo(url: string, { stage = 'upload-video' }: { stage?: string } = {}): Promise<Buffer> {
  // Mock clips are not real video: pass them through, as the mock merge used to.
  if (useMockFal) return fetchObject(url, { maxBytes: MAX_RESULT_VIDEO_BYTES });

  const started = performance.now();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clip-'));
  const out = path.join(dir, 'out.mp4');
  const call = { provider: 'local' as const, model: 'ffmpeg-static', stage, costUsdMicros: 0 };
  try {
    // Only remote input: callers pass our own storage URL (assertOwnedRawUrl), never a path.
    if (!/^https?:\/\//.test(url)) throw new Error('normalizeVideo takes an http(s) URL');
    await runFfmpeg(['-i', url, ...encodeArgs(), out]);
    if ((await stat(out)).size > MAX_RESULT_VIDEO_BYTES) throw new AppError('VIDEO_TOO_LARGE', { detail: 'normalized clip over limit' });
    const bytes = await readFile(out);
    await recordCall({ ...call, status: 'ok', latencyMs: performance.now() - started, meta: { bytes: bytes.length } });
    return bytes;
  } catch (err) {
    await recordCall({ ...call, status: 'error', latencyMs: performance.now() - started, meta: { error: String(err).slice(0, 500) } });
    if (err instanceof AppError) throw err;
    throw new AppError('VIDEO_DECODE_FAILED', { detail: err instanceof Error ? err.message : String(err), cause: err });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Output options. The scale keeps the aspect ratio, never upscales, and keeps both sides even (H.264 needs that). */
export function encodeArgs(): string[] {
  const edge = VIDEO_MAX_LONG_EDGE;
  const scale = `scale='if(gte(iw,ih),trunc(min(iw,${edge})/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(ih,${edge})/2)*2)'`;
  return [
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `fps=${VIDEO_TARGET_FPS},${scale},setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
  ];
}

function runFfmpeg(args: string[]): Promise<void> {
  if (!ffmpegPath) return Promise.reject(new Error('ffmpeg-static has no binary for this platform'));
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'http,https,tcp,tls,crypto', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), VIDEO_UTILITY_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `ffmpeg timed out after ${VIDEO_UTILITY_TIMEOUT_MS} ms` : `ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}
