import 'server-only';
import { ApiError, fal } from '@fal-ai/client';
import { env, useMockFal } from '../env';
import { AppError } from '../errors';
import { recordCall, type CallRecord } from '../telemetry';
import { mockSubmit, mockUtility } from './mock';
import { parseOutput, parseVideoOutput, VIDEO_MODEL, type AnimationResolution, type FalModel, type QueueModel, type UtilityModel } from './models';
import { falCostMicros, falVideoCostMicros, UTILITY_CALL_USD_MICROS } from './pricing';

/**
 * The only module that talks to fal. Generation always goes through the queue with a webhook;
 * `runSync` exists for scripts (bake-off, smoke tests) and must not be called from a request.
 * `runUtility` is the one synchronous call allowed in a request: fal's ffmpeg endpoints, under a hard timeout.
 *
 * Telemetry: a queued request's provider_calls row (latency, cost) is written by the webhook
 * handler when the result arrives. submitToQueue only records a row when the submission fails.
 */

if (env.FAL_KEY) fal.config({ credentials: env.FAL_KEY });

export type FalCallContext = Pick<CallRecord, 'jobId' | 'roundId' | 'candidateId'> & { stage: string };

const CONTENT_POLICY = /content[\s_-]?polic|content_policy_violation|nsfw|safety/i;

/** True when a fal error message or body says the request was refused for content reasons. */
export function isContentPolicyError(text: string): boolean {
  return CONTENT_POLICY.test(text);
}

function toAppError(err: unknown): AppError {
  if (err instanceof ApiError) {
    const text = `${err.message} ${JSON.stringify(err.body ?? '')}`;
    const code = err.status === 422 && isContentPolicyError(text) ? 'CONTENT_BLOCKED' : 'GENERATION_FAILED';
    return new AppError(code, { detail: `fal ${err.status}: ${err.message}`, cause: err });
  }
  return new AppError('GENERATION_FAILED', { detail: err instanceof Error ? err.message : String(err), cause: err });
}

export async function submitToQueue({
  model,
  input,
  webhookUrl,
  context,
}: {
  model: QueueModel;
  input: Record<string, unknown>;
  webhookUrl: string;
  context?: FalCallContext;
}): Promise<{ requestId: string }> {
  if (useMockFal) return mockSubmit({ input, webhookUrl });

  const started = performance.now();
  try {
    const { request_id } = await fal.queue.submit(model, { input, webhookUrl });
    return { requestId: request_id };
  } catch (err) {
    const appError = toAppError(err);
    await recordCall({
      ...context,
      stage: context?.stage ?? 'submit',
      provider: 'fal',
      model,
      requestId: err instanceof ApiError ? err.requestId || null : null,
      status: 'error',
      latencyMs: performance.now() - started,
      costUsdMicros: 0,
      meta: { error: appError.code, status: err instanceof ApiError ? err.status : null },
    });
    throw appError;
  }
}

/**
 * Puts a file on fal's own storage and returns its public URL. For scripts run without Vercel Blob,
 * whose local-disk URLs neither fal nor Claude can fetch. The app itself always uses lib/storage.
 */
export async function uploadToFalStorage(bytes: Buffer, contentType: string): Promise<string> {
  if (useMockFal) throw new Error('uploadToFalStorage needs FAL_KEY');
  return fal.storage.upload(new Blob([new Uint8Array(bytes)], { type: contentType }));
}

/** Blocking call for scripts. Writes one provider_calls row. Mock mode echoes the first input image. */
export async function runSync({
  model,
  input,
  context,
}: {
  model: FalModel;
  input: Record<string, unknown>;
  context?: FalCallContext;
}): Promise<{ requestId: string; imageUrls: string[] }> {
  if (useMockFal) {
    const urls = (input.image_urls as string[] | undefined) ?? [input.base_image_url as string];
    return { requestId: 'mock-sync', imageUrls: urls.slice(0, 1) };
  }

  const started = performance.now();
  try {
    const result = await fal.subscribe(model, { input, logs: false });
    const { imageUrls } = parseOutput(result.data);
    await recordCall({
      ...context,
      stage: context?.stage ?? 'run_sync',
      provider: 'fal',
      model,
      requestId: result.requestId,
      status: imageUrls.length > 0 ? 'ok' : 'error',
      latencyMs: performance.now() - started,
      costUsdMicros: falCostMicros(model, imageUrls.length),
      meta: { images: imageUrls.length },
    });
    return { requestId: result.requestId, imageUrls };
  } catch (err) {
    const appError = toAppError(err);
    await recordCall({
      ...context,
      stage: context?.stage ?? 'run_sync',
      provider: 'fal',
      model,
      requestId: err instanceof ApiError ? err.requestId || null : null,
      status: 'error',
      latencyMs: performance.now() - started,
      costUsdMicros: 0,
      meta: { error: appError.code },
    });
    throw appError;
  }
}

/**
 * One synchronous call to a fal ffmpeg endpoint (probe, re-encode, frame grab), for the video
 * upload path. Aborts after `timeoutMs`. Writes one provider_calls row. Returns fal's raw output.
 */
export async function runUtility({
  model,
  input,
  timeoutMs,
  context,
}: {
  model: UtilityModel;
  input: Record<string, unknown>;
  timeoutMs: number;
  context?: FalCallContext;
}): Promise<unknown> {
  if (useMockFal) return mockUtility(model, input);

  const started = performance.now();
  try {
    // fal types each endpoint's input; ours are built by the typed helpers in models.ts.
    const result = await fal.subscribe(model, { input: input as never, logs: false, abortSignal: AbortSignal.timeout(timeoutMs) });
    await recordCall({
      ...context,
      stage: context?.stage ?? 'utility',
      provider: 'fal',
      model,
      requestId: result.requestId,
      status: 'ok',
      latencyMs: performance.now() - started,
      costUsdMicros: UTILITY_CALL_USD_MICROS,
    });
    return result.data;
  } catch (err) {
    const appError = toAppError(err);
    await recordCall({
      ...context,
      stage: context?.stage ?? 'utility',
      provider: 'fal',
      model,
      requestId: err instanceof ApiError ? err.requestId || null : null,
      status: 'error',
      latencyMs: performance.now() - started,
      costUsdMicros: 0,
      meta: { error: appError.code, status: err instanceof ApiError ? err.status : null },
    });
    throw appError;
  }
}

/**
 * Blocking VIDEO_MODEL call for scripts (the video bake-off). Never call it from a request. Writes one
 * provider_calls row, priced from `frames` (the input clip's frame count).
 */
export async function runVideoSync({
  input,
  frames,
  resolution,
  context,
}: {
  input: Record<string, unknown>;
  frames: number;
  resolution: AnimationResolution;
  context?: FalCallContext;
}): Promise<{ requestId: string; videoUrl: string | null; latencyMs: number }> {
  if (useMockFal) throw new Error('runVideoSync needs FAL_KEY');
  const started = performance.now();
  try {
    const result = await fal.subscribe(VIDEO_MODEL, { input: input as never, logs: false });
    const { videoUrl } = parseVideoOutput(result.data);
    const latencyMs = performance.now() - started;
    await recordCall({
      ...context,
      stage: context?.stage ?? 'run_sync',
      provider: 'fal',
      model: VIDEO_MODEL,
      requestId: result.requestId,
      status: videoUrl ? 'ok' : 'error',
      latencyMs,
      costUsdMicros: videoUrl ? falVideoCostMicros(frames, resolution) : 0,
      meta: { frames, resolution },
    });
    return { requestId: result.requestId, videoUrl, latencyMs };
  } catch (err) {
    const appError = toAppError(err);
    await recordCall({
      ...context,
      stage: context?.stage ?? 'run_sync',
      provider: 'fal',
      model: VIDEO_MODEL,
      requestId: err instanceof ApiError ? err.requestId || null : null,
      status: 'error',
      latencyMs: performance.now() - started,
      costUsdMicros: 0,
      meta: { error: appError.code },
    });
    throw appError;
  }
}
