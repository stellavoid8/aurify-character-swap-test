import type { ERRORS, NOTICES } from './errors';

export type ErrorCode = keyof typeof ERRORS;
export type NoticeCode = keyof typeof NOTICES;

/** Error shape sent to the browser by Server Actions and Route Handlers. */
export type ApiError = { code: ErrorCode; message: string };

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** JSON body of every Route Handler response. */
export type ApiResponse<T> = { data: T } | { error: ApiError };

/** A detected face. Coordinates are normalized 0–1 to the image size. */
export type FaceBox = {
  box: [x: number, y: number, w: number, h: number];
  score: number;
  /** Five landmarks: eyes, nose tip, mouth corners. */
  landmarks: [number, number][];
};

/** A non-blocking notice stored on `jobs.notices`; `params` fill the `{name}` placeholders in `NOTICES`. */
export type JobNotice = { code: NoticeCode; params?: Record<string, string | number> };

/** Mismatches between the template subject and the user, stored on `jobs.flags`. */
export type JobFlags = {
  crossGender: boolean;
  crossAge: boolean;
  multiPerson: boolean;
  subjectLabel: string | null;
};

/** Per-stage timing on `job_rounds.stage_timings`. */
export type StageTimings = Partial<Record<string, { startedAt: string; endedAt: string | null; ms: number | null }>>;

/** A detected face in pixel coordinates of the image it was found in. Normalize with `toFaceBox` before storing. */
export type Face = {
  box: [x: number, y: number, w: number, h: number];
  score: number;
  /** Five landmarks, as SCRFD orders them: eye on the image's left, other eye, nose tip, mouth corner on the image's left, other mouth corner. */
  landmarks: [number, number][];
};

/** Decoded pixels: tightly packed RGB, 3 bytes per pixel, row-major. */
export type RgbImage = { data: Uint8Array; width: number; height: number };

/** What the browser learns about a normalized upload. Boxes are normalized 0–1. */
export type UploadView = {
  id: string;
  kind: 'template' | 'user';
  status: 'pending' | 'ok' | 'rejected';
  rejectCode: string | null;
  url: string | null;
  width: number;
  height: number;
  /** Confident faces only (score ≥ FACE_MIN_SCORE). */
  faceCount: number;
  /** Template only: the face that will be swapped. */
  subjectBox: FaceBox['box'] | null;
  qualityScore: number | null;
};

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out';
export type JobStage = 'analyzing' | 'generating' | 'ranking' | 'refining' | 'done';

export type CandidateView = {
  id: string;
  round: number;
  kind: 'generation' | 'refinement';
  status: 'pending' | 'succeeded' | 'failed';
  imageUrl: string | null;
  identityScore: number | null;
  actionScore: number | null;
  rank: number | null;
  parentCandidateId: string | null;
};

/** Everything the job page shows: rendered by the page and returned by `GET /api/jobs/[id]`. Plain JSON. */
export type JobView = {
  id: string;
  status: JobStatus;
  stage: JobStage;
  round: number;
  /** Since the current round started; frozen once it finished. */
  elapsedMs: number;
  etaMs: number;
  deadlineAt: string | null;
  error: { code: ErrorCode; message: string; nextStep: string } | null;
  template: {
    url: string | null;
    width: number;
    height: number;
    subjectBox: FaceBox['box'] | null;
    peopleCount: number | null;
    subjectLabel: string | null;
  };
  userPhotos: { id: string; url: string | null; isReference: boolean }[];
  notices: { code: NoticeCode; message: string }[];
  /** Ordered by round, then rank (unranked last). */
  candidates: CandidateView[];
  chosenCandidateId: string | null;
  canRetry: boolean;
  canRefine: boolean;
  unitsLeftToday: number;
};
