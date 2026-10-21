import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { toResponse } from '@/lib/errors';
import { faceEngine, decodeRgb } from '@/lib/face';
import { ARCFACE_SIZE } from '@/lib/face/align';
import { embed } from '@/lib/face/arcface';
import { detectFaces } from '@/lib/face/scrfd';
import { requireSession } from '@/lib/session';

// TEMPORARY (removed in prompt 17): proves the ONNX face engine runs inside a deployed function and how fast.
// Served at /api/_health/face; the %5F prefix stops the App Router treating `_health` as a private folder.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SAMPLE = path.join(process.cwd(), 'public', 'seed', 'candidate-1.jpg');

/** The seed image when it exists (it is gitignored, so deployments usually lack it), else a plain grey stand-in. */
async function sampleJpeg(): Promise<{ jpeg: Buffer; source: string }> {
  if (existsSync(SAMPLE)) return { jpeg: await readFile(SAMPLE), source: 'public/seed/candidate-1.jpg' };
  const jpeg = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#9a9a9a' } }).jpeg().toBuffer();
  return { jpeg, source: 'generated 512×512 grey' };
}

let served = 0;

export async function GET(): Promise<Response> {
  try {
    await requireSession();
    const engine = faceEngine.name;
    if (engine !== 'onnx') return Response.json({ data: { engine, faces: null, detectMs: null, embedMs: null } });

    const { jpeg, source } = await sampleJpeg();
    const rgb = await decodeRgb(jpeg);
    const cold = served++ === 0;

    let started = performance.now();
    const faces = await detectFaces(rgb);
    const detectMs = Math.round(performance.now() - started);

    const left = Math.max(0, Math.floor((rgb.width - ARCFACE_SIZE) / 2));
    const top = Math.max(0, Math.floor((rgb.height - ARCFACE_SIZE) / 2));
    const { data } = await sharp(jpeg).removeAlpha().extract({ left, top, width: ARCFACE_SIZE, height: ARCFACE_SIZE }).raw().toBuffer({ resolveWithObject: true });
    started = performance.now();
    await embed({ data: new Uint8Array(data), width: ARCFACE_SIZE, height: ARCFACE_SIZE });
    const embedMs = Math.round(performance.now() - started);

    return Response.json({ data: { engine, faces: faces.length, detectMs, embedMs, cold, source } });
  } catch (err) {
    return toResponse(err);
  }
}
