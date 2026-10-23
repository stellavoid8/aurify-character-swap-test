import 'server-only';
import { db } from '../db';
import { uploads, type NewUpload, type Upload } from '../db/schema';
import { AppError } from '../errors';
import { faceEngine, pickSubjectFace, qualityScore, toFaceBox } from '../face';
import { runUtility, type FalCallContext } from '../fal/client';
import { buildFrameInput, FFMPEG_EXTRACT_FRAME, FFMPEG_METADATA, parseFrameOutput, parseVideoMetadata, type FrameType } from '../fal/models';
import { normalizeImage } from '../images';
import { FACE_MIN_AREA_FRAC, FACE_MIN_SCORE, MAX_VIDEO_SECONDS, VIDEO_DURATION_TOLERANCE_MS, VIDEO_TARGET_FPS, VIDEO_UTILITY_TIMEOUT_MS } from '../limits';
import { deleteObjects, fetchObject, putObject } from '../storage';
import type { Face } from '../types';
import { normalizeVideo } from '../videos';

/**
 * Upload-time step for a template clip: raw clip → probe (fal) → re-encode to VIDEO_TARGET_FPS and at most
 * VIDEO_MAX_LONG_EDGE (local ffmpeg, lib/videos.ts) → our copy → keyframe → one `uploads` row. The row's `url` is the keyframe
 * JPEG, so analysis, reference selection and the generators work on a clip as on a photo.
 * Every check failure throws (VIDEO_TOO_LONG, VIDEO_DECODE_FAILED, VIDEO_MULTIPLE_PEOPLE) and leaves
 * no row and no stored copy. The raw clip is deleted in every case, as raw photos are.
 * See docs/decisions/0002-video-swap-architecture.md.
 */

const FRAMES: FrameType[] = ['first', 'middle', 'last'];

type Keyframe = { frame: FrameType; jpeg: Buffer; width: number; height: number; faces: Face[]; subject: number | null; quality: number };

export async function preprocessVideoUpload({ sid, rawUrl }: { sid: string; rawUrl: string }): Promise<Upload> {
  const context: FalCallContext = { stage: 'upload-video' };
  const stored: string[] = [];
  try {
    const meta = parseVideoMetadata(await utility(FFMPEG_METADATA, { media_url: rawUrl }, context));
    if (meta.durationMs === null) throw new AppError('VIDEO_DECODE_FAILED', { detail: 'probe has no duration' });
    if (meta.durationMs > MAX_VIDEO_SECONDS * 1000 + VIDEO_DURATION_TOLERANCE_MS) {
      throw new AppError('VIDEO_TOO_LONG', { detail: `clip is ${meta.durationMs} ms` });
    }

    const clip = await normalizeVideo(rawUrl);
    const { url: videoUrl } = await putObject(`sessions/${sid}/clips/${crypto.randomUUID()}.mp4`, clip, 'video/mp4');
    stored.push(videoUrl);

    const keyframe = pickKeyframe(await Promise.all(FRAMES.map((frame) => grabFrame(videoUrl, frame, context))));
    if (countPeople(keyframe) > 1) throw new AppError('VIDEO_MULTIPLE_PEOPLE');
    const { url } = await putObject(`sessions/${sid}/norm/${crypto.randomUUID()}.jpg`, keyframe.jpeg, 'image/jpeg');
    stored.push(url);

    const row: NewUpload = {
      sessionId: sid,
      kind: 'template',
      mediaType: 'video',
      status: 'ok',
      rawUrl,
      url,
      width: keyframe.width,
      height: keyframe.height,
      bytes: clip.length,
      faces: keyframe.faces.map((face) => toFaceBox(face, keyframe.width, keyframe.height)),
      subjectFaceIndex: keyframe.subject,
      qualityScore: keyframe.subject === null ? null : keyframe.quality,
      videoUrl,
      durationMs: meta.durationMs,
      fps: VIDEO_TARGET_FPS,
      frameCount: Math.round((meta.durationMs / 1000) * VIDEO_TARGET_FPS),
      keyframe: keyframe.frame,
    };
    const [upload] = await db.insert(uploads).values(row).returning();
    return upload;
  } catch (err) {
    await deleteObjects(stored).catch((delErr) => console.error('[preprocess-video] cleanup failed', { delErr }));
    if (err instanceof AppError && err.code === 'FILE_TOO_LARGE') throw new AppError('VIDEO_TOO_LARGE', { detail: err.message, cause: err });
    if (err instanceof AppError && err.code !== 'GENERATION_FAILED') throw err;
    // A fal refusal or timeout on any step means we can't use this clip.
    throw new AppError('VIDEO_DECODE_FAILED', { detail: err instanceof Error ? err.message : String(err), cause: err });
  } finally {
    // Logged, not thrown: a leftover raw file must not fail an otherwise good upload.
    await deleteObjects([rawUrl]).catch((err) => console.error('[preprocess-video] raw delete failed', { err }));
  }
}

function utility(model: Parameters<typeof runUtility>[0]['model'], input: Record<string, unknown>, context: FalCallContext) {
  return runUtility({ model, input, timeoutMs: VIDEO_UTILITY_TIMEOUT_MS, context });
}

async function grabFrame(videoUrl: string, frame: FrameType, context: FalCallContext): Promise<Keyframe> {
  const { imageUrl } = parseFrameOutput(await utility(FFMPEG_EXTRACT_FRAME, buildFrameInput({ videoUrl, frame }), context));
  if (!imageUrl) throw new AppError('VIDEO_DECODE_FAILED', { detail: `no ${frame} frame` });
  const bytes = await fetchObject(imageUrl);
  // Only removes our own objects (mock frames); fal's URLs are ignored.
  await deleteObjects([imageUrl]).catch(() => undefined);
  const { jpeg, width, height } = await normalizeImage(bytes);
  const { faces } = await faceEngine.analyzeImage(jpeg, { stage: 'upload-video' });
  const subject = pickSubjectFace(faces, width, height);
  return { frame, jpeg, width, height, faces, subject, quality: subject === null ? -1 : qualityScore(faces[subject], width, height) };
}

/** The frame showing the subject's face best; the first frame when none shows a face. */
function pickKeyframe(frames: Keyframe[]): Keyframe {
  return frames.reduce((best, frame) => (frame.quality > best.quality ? frame : best));
}

/** Confident faces large enough to be a person in the scene, not someone in the background. */
function countPeople({ faces, width, height }: Keyframe): number {
  return faces.filter((f) => f.score >= FACE_MIN_SCORE && (f.box[2] * f.box[3]) / (width * height) >= FACE_MIN_AREA_FRAC).length;
}
