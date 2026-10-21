import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { FaceBox, JobFlags, JobNotice, StageTimings } from '../types';

/**
 * The whole data model. Drizzle migrations generated from this file are the only schema source.
 * Every table enables RLS with no policies: Supabase's Data API roles can't touch them, while the
 * app connects as `postgres`, which owns the tables and bypasses RLS.
 * Money is always an integer number of micro-dollars (`cost_usd_micros`), never a float.
 */

export const uploadKind = pgEnum('upload_kind', ['template', 'user']);
export const uploadStatus = pgEnum('upload_status', ['pending', 'ok', 'rejected']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'failed', 'timed_out']);
export const jobStage = pgEnum('job_stage', ['analyzing', 'generating', 'ranking', 'refining', 'done']);
export const roundKind = pgEnum('round_kind', ['generation', 'refinement']);
export const roundStatus = pgEnum('round_status', ['running', 'succeeded', 'failed', 'timed_out']);
export const candidateStatus = pgEnum('candidate_status', ['pending', 'succeeded', 'failed']);
export const provider = pgEnum('provider', ['fal', 'anthropic', 'local']);
export const callStatus = pgEnum('call_status', ['ok', 'error']);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const costUsdMicros = () => bigint('cost_usd_micros', { mode: 'number' });

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    kind: uploadKind('kind').notNull(),
    status: uploadStatus('status').notNull().default('pending'),
    rejectCode: text('reject_code'),
    rawUrl: text('raw_url').notNull(),
    /** Normalized JPEG; null until normalization succeeds. */
    url: text('url'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    faces: jsonb('faces').$type<FaceBox[]>().notNull().default([]),
    /** Template only: which detected face is the subject to replace. */
    subjectFaceIndex: integer('subject_face_index'),
    qualityScore: real('quality_score'),
    /** User only: 512-d identity embedding. */
    embedding: real('embedding').array(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [index('uploads_session_created_idx').on(t.sessionId, t.createdAt)],
).enableRLS();

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    status: jobStatus('status').notNull().default('queued'),
    stage: jobStage('stage').notNull().default('analyzing'),
    templateUploadId: uuid('template_upload_id')
      .notNull()
      .references(() => uploads.id),
    userUploadIds: uuid('user_upload_ids').array().notNull(),
    referenceUploadId: uuid('reference_upload_id').references(() => uploads.id),
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    flags: jsonb('flags')
      .$type<JobFlags>()
      .notNull()
      .default({ crossGender: false, crossAge: false, multiPerson: false, subjectLabel: null }),
    prompt: text('prompt'),
    currentRound: integer('current_round').notNull().default(0),
    /** Plain uuid with no FK: candidates reference jobs, so an FK here would be a cycle on insert. */
    chosenCandidateId: uuid('chosen_candidate_id'),
    notices: jsonb('notices').$type<JobNotice[]>().notNull().default([]),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    deadlineAt: timestamptz('deadline_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [index('jobs_session_created_idx').on(t.sessionId, t.createdAt)],
).enableRLS();

/** One row = one rate-limit unit. */
export const jobRounds = pgTable(
  'job_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    round: integer('round').notNull(),
    kind: roundKind('kind').notNull(),
    status: roundStatus('status').notNull().default('running'),
    stageTimings: jsonb('stage_timings').$type<StageTimings>().notNull().default({}),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    unique('job_rounds_job_round_unique').on(t.jobId, t.round),
    index('job_rounds_session_started_idx').on(t.sessionId, t.startedAt),
    index('job_rounds_started_idx').on(t.startedAt),
  ],
).enableRLS();

export const candidates = pgTable(
  'candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id')
      .notNull()
      .references(() => jobRounds.id, { onDelete: 'cascade' }),
    kind: roundKind('kind').notNull(),
    parentCandidateId: uuid('parent_candidate_id').references((): AnyPgColumn => candidates.id),
    model: text('model').notNull(),
    seed: integer('seed').notNull(),
    attempt: integer('attempt').notNull().default(1),
    falRequestId: text('fal_request_id').unique('candidates_fal_request_id_unique'),
    status: candidateStatus('status').notNull().default('pending'),
    /** Our Blob copy of the result, not fal's URL. */
    imageUrl: text('image_url'),
    identityScore: real('identity_score'),
    actionScore: real('action_score'),
    rank: integer('rank'),
    scorer: text('scorer').$type<'onnx' | 'mock'>(),
    errorCode: text('error_code'),
    latencyMs: integer('latency_ms'),
    costUsdMicros: costUsdMicros(),
    submittedAt: timestamptz('submitted_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [index('candidates_round_idx').on(t.roundId)],
).enableRLS();

export const providerCalls = pgTable('provider_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
  roundId: uuid('round_id'),
  candidateId: uuid('candidate_id'),
  provider: provider('provider').notNull(),
  model: text('model').notNull(),
  stage: text('stage').notNull(),
  requestId: text('request_id'),
  status: callStatus('status').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  costUsdMicros: costUsdMicros().notNull().default(0),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}).enableRLS();

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    requestId: text('request_id').notNull(),
    candidateId: uuid('candidate_id').references(() => candidates.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    processedAt: timestamptz('processed_at'),
  },
  (t) => [unique('webhook_events_provider_request_status_unique').on(t.provider, t.requestId, t.status)],
).enableRLS();

export type Upload = typeof uploads.$inferSelect;
export type NewUpload = typeof uploads.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type JobRound = typeof jobRounds.$inferSelect;
export type Candidate = typeof candidates.$inferSelect;
export type ProviderCall = typeof providerCalls.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
