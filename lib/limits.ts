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

// Generation
export const CANDIDATES_PER_ROUND = 3;
export const MAX_AUTO_RETRIES = 1;
export const MAX_ROUNDS_PER_JOB = 6;
export const JOB_TIMEOUT_MS = 6 * 60_000;
export const POLL_INTERVAL_MS = 2500;

// Daily caps: one `job_rounds` row is one unit.
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

// Waiting screen ETA: fall back to the default until enough recent rounds exist.
export const DEFAULT_ETA_MS = 90_000;
export const ETA_MIN_SAMPLES = 5;

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
