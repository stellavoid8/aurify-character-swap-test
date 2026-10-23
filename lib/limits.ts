/**
 * Every tunable number in the app. Read from here; never inline.
 * Safe to import from client components: the env-backed values load `lib/env.ts` lazily, so it never lands in a browser bundle.
 */

/** Wrong access codes allowed per IP within GATE_WINDOW_MS before /gate locks that IP out. */
export const GATE_MAX_FAILS = 10;
export const GATE_WINDOW_MS = 15 * 60_000;
/** Pause before answering a wrong access code, to slow down guessing. */
export const GATE_FAIL_DELAY_MS = 400;

// Uploads
export const MAX_USER_PHOTOS = 4;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const ACCEPTED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
/** Long edge of the normalized JPEG every pipeline step reads. */
export const NORMALIZE_LONG_EDGE = 1536;
/** The browser shrinks photos to this long edge before uploading, to save mobile data. */
export const CLIENT_PRERESIZE_LONG_EDGE = 2560;
/** Timeout for server-side reads of stored or provider images. */
export const FETCH_TIMEOUT_MS = 30_000;

// Video templates (docs/decisions/0002-video-swap-architecture.md)
export const MAX_VIDEO_SECONDS = 15;
/** Container durations round up a little; a clip this much over MAX_VIDEO_SECONDS still passes. */
export const VIDEO_DURATION_TOLERANCE_MS = 250;
/** Every clip is re-encoded to this frame rate at upload: fal bills video by frames ÷ 16, so this bounds the cost. */
export const VIDEO_TARGET_FPS = 24;
/** Long edge of the normalized clip; the video model renders at most 720p. */
export const VIDEO_MAX_LONG_EDGE = 1280;
/** A 15 s 4K60 HEVC phone clip fits. Photos keep MAX_UPLOAD_BYTES. */
export const MAX_VIDEO_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Cap for server-side reads of normalized clips and result videos. */
export const MAX_RESULT_VIDEO_BYTES = 60 * 1024 * 1024;
export const ACCEPTED_VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
export const ACCEPTED_VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v'];
/** Per-call limit for the synchronous fal ffmpeg calls (probe, re-encode, frame grabs) in the normalize action. */
export const VIDEO_UTILITY_TIMEOUT_MS = 60_000;

// Generation
export const MAX_AUTO_RETRIES = 1;
export const MAX_ROUNDS_PER_JOB = 6;
export const JOB_TIMEOUT_MS = 6 * 60_000;
/** Deadline of an animation round: a 15 s render is several model windows. Tune from bake-off timings. */
export const ANIMATION_TIMEOUT_MS = 25 * 60_000;
/** Rate-limit weight of an animation round: about 5× the cost of a still round. */
export const ANIMATION_ROUND_UNITS = 5;
/** Output resolution of the video model: '480p' | '580p' | '720p'. */
export const ANIMATION_RESOLUTION = '580p';
export const POLL_INTERVAL_MS = 2500;
/** After this many failed polls in a row the waiting screen says the connection is lost and slows down. */
export const POLL_MAX_ERRORS = 3;
export const POLL_BACKOFF_MS = 10_000;

// Daily caps: one `job_rounds` row is `units` units (1, or ANIMATION_ROUND_UNITS for an animation round).
export const SESSION_DAILY_UNITS = 20;
export async function globalDailyUnits(): Promise<number> {
  const { env } = await import('./env');
  return env.GLOBAL_DAILY_UNITS;
}

/** Days to keep uploads and results before the cleanup cron deletes them. */
export async function retentionDays(): Promise<number> {
  const { env } = await import('./env');
  return env.RETENTION_DAYS;
}

/** The cleanup cron deletes expired jobs and orphan uploads this many at a time (also the Blob delete batch). */
export const CLEANUP_BATCH_SIZE = 100;
/** Uploads no job uses, and leftover raw photos, are deleted once they are this old. */
export const ORPHAN_MAX_AGE_MS = 24 * 60 * 60_000;

// Waiting screen ETA: fall back to the default until enough recent rounds exist.
export const DEFAULT_ETA_MS = 90_000;
export const ETA_MIN_SAMPLES = 5;
/** Animation ETA fallback per second of clip, until ETA_MIN_SAMPLES animation rounds exist. */
export const DEFAULT_ANIMATION_MS_PER_SECOND = 20_000;
/** Rounds older than this don't count toward the ETA. */
export const ETA_WINDOW_DAYS = 7;
export const ETA_CACHE_SECONDS = 5 * 60;
/** The waiting screen's screen-reader elapsed time updates this often (the visible timer ticks every second). */
export const ELAPSED_ANNOUNCE_MS = 30_000;

// Face checks
export const FACE_MIN_SCORE = 0.5;
/** Face box area as a fraction of the image area. Smaller confident faces are treated as background people. */
export const FACE_MIN_AREA_FRAC = 0.015;
/** SCRFD: candidate faces below this confidence are dropped before NMS. */
export const FACE_DETECT_SCORE = 0.4;
/** SCRFD: overlapping detections above this IoU are merged by NMS. */
export const FACE_NMS_IOU = 0.4;
export const FACE_MIN_SIDE_PX = 64;
/** Shorter face-box side as a fraction of the image's shorter side. */
export const FACE_MIN_SIDE_FRAC = 0.06;
/** Below this cosine similarity to the other photos, a user photo is likely a different person. */
export const MISMATCH_COSINE = 0.35;
/** Identity scores closer than this are a tie; action score decides. */
export const TIE_BREAK_DELTA = 0.03;
/** In a tie, each action-score point (1–5) is worth this much identity. */
export const TIE_BREAK_ACTION_WEIGHT = 0.02;

// Providers
/** Output cap for one vision-LLM call (template analysis or action rating). */
export const AI_MAX_TOKENS = 2000;
/** Wait before the single retry of a rate-limited or dropped Anthropic call. */
export const AI_RETRY_DELAY_MS = 2000;
/** Mock fal sends its webhook after a random delay in this range. */
export const MOCK_FAL_DELAY_MIN_MS = 2000;
export const MOCK_FAL_DELAY_MAX_MS = 4000;
/** Per-attempt timeout for one Anthropic call. */
export const AI_TIMEOUT_MS = 90_000;
