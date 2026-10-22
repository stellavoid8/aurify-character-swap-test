import 'server-only';
import { ApiError, fal } from '@fal-ai/client';
import { env, useMockFal } from '../env';
import { AppError } from '../errors';
import { recordCall, type CallRecord } from '../telemetry';
import { mockSubmit } from './mock';
import { parseOutput, type FalModel } from './models';
import { falCostMicros } from './pricing';

/**
 * The only module that talks to fal. Generation always goes through the queue with a webhook;
 * `runSync` exists for scripts (bake-off, smoke tests) and must not be called from a request.
 *
 * Telemetry: a queued request's provider_calls row (latency, cost) is written by the webhook
 * handler when the result arrives. submitToQueue only records a row when the submission fails.
 */

if (env.FAL_KEY) fal.config({ credentials: env.FAL_KEY });

export type FalCallContext = Pick<CallRecord, 'jobId' | 'roundId' | 'candidateId'> & { stage: string };

const CONTENT_POLICY = /content[\s_-]?polic|content_policy_violation|nsfw|safety/i;

function toAppError(err: unknown): AppError {
  if (err instanceof ApiError) {
    const text = `${err.message} ${JSON.stringify(err.body ?? '')}`;
    const code = err.status === 422 && CONTENT_POLICY.test(text) ? 'CONTENT_BLOCKED' : 'GENERATION_FAILED';
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
  model: FalModel;
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
