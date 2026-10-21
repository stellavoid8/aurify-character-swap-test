import { ZodError } from 'zod';
import { GATE_WINDOW_MS, MAX_UPLOAD_BYTES, MAX_USER_PHOTOS, SESSION_DAILY_UNITS } from './limits';
import type { ActionResult, ApiError, ErrorCode, NoticeCode } from './types';

type ErrorDef = {
  status: number;
  /** What went wrong, in plain words. */
  message: string;
  /** What the user should do next. */
  nextStep: string;
  /** Never shown in the UI (machine-to-machine endpoints). */
  internal?: true;
};

export const ERRORS = {
  ACCESS_DENIED: { status: 401, message: 'Enter the access code to continue.', nextStep: 'Go to the sign-in page.' },
  INVALID_ACCESS_CODE: { status: 400, message: "That code didn't work.", nextStep: 'Check the code and try again.' },
  TOO_MANY_ATTEMPTS: { status: 429, message: 'Too many tries.', nextStep: `Wait ${GATE_WINDOW_MS / 60_000} minutes and try again.` },
  RATE_LIMITED_SESSION: {
    status: 429,
    message: `You've reached today's limit of ${SESSION_DAILY_UNITS} pictures.`,
    nextStep: 'Come back tomorrow.',
  },
  RATE_LIMITED_GLOBAL: {
    status: 429,
    message: "The app has reached today's limit for everyone.",
    nextStep: 'Please try again tomorrow.',
  },
  VALIDATION_FAILED: {
    status: 400,
    message: "Something in the request wasn't right.",
    nextStep: 'Reload the page and try again.',
  },
  UNSUPPORTED_FILE_TYPE: {
    status: 415,
    message: "That file isn't a photo we can use.",
    nextStep: 'Choose a JPG, PNG, WebP or HEIC photo.',
  },
  FILE_TOO_LARGE: {
    status: 413,
    message: `That photo is over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    nextStep: 'Choose a smaller photo, or take a screenshot of it.',
  },
  IMAGE_DECODE_FAILED: {
    status: 422,
    message: "We couldn't open that photo.",
    nextStep: 'Try another photo, or save it as a JPG first.',
  },
  UPLOAD_FAILED: { status: 502, message: "The upload didn't finish.", nextStep: 'Check your connection and try again.' },
  NO_FACE: {
    status: 422,
    message: "We can't see a face in this photo.",
    nextStep: 'Use a photo where your face is clear and facing the camera.',
  },
  MULTIPLE_FACES: {
    status: 422,
    message: "There's more than one person in this photo.",
    nextStep: 'Use a photo of just you.',
  },
  FACE_TOO_SMALL: {
    status: 422,
    message: 'Your face is too small in this photo.',
    nextStep: 'Use a closer photo, from the chest up.',
  },
  TOO_MANY_PHOTOS: {
    status: 400,
    message: `You can add up to ${MAX_USER_PHOTOS} photos of yourself.`,
    nextStep: 'Remove a photo to add another.',
  },
  UPLOAD_NOT_FOUND: { status: 404, message: "We can't find that photo.", nextStep: 'Add the photo again.' },
  JOB_NOT_FOUND: { status: 404, message: "We can't find that picture.", nextStep: 'Start a new picture.' },
  INVALID_STATE: { status: 409, message: 'This picture is still being made.', nextStep: 'Wait for it to finish.' },
  ANALYSIS_FAILED: {
    status: 502,
    message: "We couldn't read the template photo.",
    nextStep: 'Tap Try again, or pick a different template.',
  },
  CONTENT_BLOCKED: {
    status: 422,
    message: 'The image service declined these photos. This sometimes happens with photos of children.',
    nextStep: 'Try different photos.',
  },
  GENERATION_FAILED: { status: 502, message: "We couldn't make your picture this time.", nextStep: 'Tap Try again.' },
  JOB_TIMED_OUT: {
    status: 504,
    message: 'This is taking much longer than usual.',
    nextStep: 'Tap Try again to start over.',
  },
  REFINEMENT_FAILED: {
    status: 502,
    message: "We couldn't fix the face this time. Your picture is unchanged.",
    nextStep: 'Keep the current version or tap Try again.',
  },
  /** /api/blob/upload in local-storage mode: tells the browser to use /api/dev-upload instead. */
  DIRECT_UPLOAD_UNAVAILABLE: {
    status: 404,
    message: 'Direct upload is not configured.',
    nextStep: 'Use the local upload route.',
    internal: true,
  },
  WEBHOOK_UNAUTHORIZED: { status: 401, message: 'Not authorized.', nextStep: 'No action needed.', internal: true },
  CRON_UNAUTHORIZED: { status: 401, message: 'Not authorized.', nextStep: 'No action needed.', internal: true },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong on our side.', nextStep: 'Try again in a moment.' },
} as const satisfies Record<string, ErrorDef>;

/** Non-blocking notices. `{name}` placeholders are filled by `formatNotice`. */
export const NOTICES = {
  TEMPLATE_NO_FACE_FOUND: { message: "We couldn't find a face in the template. Results may be less accurate." },
  TEMPLATE_MULTIPLE_PEOPLE: { message: "Your template has {count} people. We'll swap {subjectLabel}." },
  PHOTO_EXCLUDED_OCCLUSION: { message: "We didn't use photo {n}: {reason}." },
  PHOTO_EXCLUDED_MISMATCH: { message: "We didn't use photo {n}: it may be a different person." },
  ALL_PHOTOS_WEAK: { message: 'None of your photos were ideal, so we used the clearest one.' },
  LATE_RESULTS_ADDED: { message: 'A version from your earlier attempt finished late and was added below.' },
} as const satisfies Record<string, { message: string }>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value);
}

export function formatNotice(code: NoticeCode, params: Record<string, string | number> = {}): string {
  return NOTICES[code].message.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  /** `detail` is for logs only; users always see the catalogue copy for `code`. */
  constructor(code: ErrorCode, options: { detail?: string; cause?: unknown } = {}) {
    super(options.detail ?? ERRORS[code].message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERRORS[code].status;
  }
}

/** Maps any thrown value to a user-safe error. Unknown errors are logged and become INTERNAL_ERROR. */
export function toApiError(err: unknown): ApiError {
  let code: ErrorCode;
  if (err instanceof AppError) {
    code = err.code;
  } else if (err instanceof ZodError) {
    code = 'VALIDATION_FAILED';
  } else {
    console.error('[unhandled]', err);
    code = 'INTERNAL_ERROR';
  }
  return { code, message: ERRORS[code].message };
}

/** For Server Actions: `catch (err) { return toActionError(err); }` */
export function toActionError(err: unknown): Extract<ActionResult<never>, { ok: false }> {
  return { ok: false, error: toApiError(err) };
}

/** For Route Handlers: `{ error: { code, message } }` with the catalogue HTTP status. */
export function toResponse(err: unknown): Response {
  const error = toApiError(err);
  return Response.json({ error }, { status: ERRORS[error.code].status });
}
