import 'server-only';
import { randomInt, randomUUID } from 'node:crypto';
import { after } from 'next/server';
import sharp from 'sharp';
import { env } from '../env';
import { MOCK_FAL_DELAY_MAX_MS, MOCK_FAL_DELAY_MIN_MS } from '../limits';
import { putObject } from '../storage';
import { FFMPEG_EXTRACT_FRAME, FFMPEG_MERGE, FFMPEG_METADATA, type UtilityModel } from './models';

/**
 * Stands in for the fal queue when FAL_KEY is unset: accepts the submission, then calls the
 * webhook a few seconds later with the first input image as the "result" (the input clip, for the
 * video model). `mockUtility` stands in for the ffmpeg endpoints.
 * MOCK_FAL_FAILURE_MODE=once fails attempt 1 only; =always fails every attempt.
 */

/** Same body shape fal POSTs to a webhook. */
export type MockWebhookBody =
  | { request_id: string; status: 'OK'; payload: { images: { url: string }[] } }
  | { request_id: string; status: 'OK'; payload: { video: { url: string } } }
  | { request_id: string; status: 'ERROR'; error: string; payload: null };

function firstInputImage(input: Record<string, unknown>): string | null {
  const urls = input.image_urls;
  if (Array.isArray(urls) && typeof urls[0] === 'string') return urls[0];
  return typeof input.base_image_url === 'string' ? input.base_image_url : null;
}

function attemptFrom(webhookUrl: string): number {
  return Number(new URL(webhookUrl).searchParams.get('a') ?? 1);
}

export function mockWebhookBody(requestId: string, input: Record<string, unknown>, attempt: number): MockWebhookBody {
  const mode = env.MOCK_FAL_FAILURE_MODE;
  const video = typeof input.video_url === 'string' ? input.video_url : null;
  const image = firstInputImage(input);
  if (mode === 'always' || (mode === 'once' && attempt === 1) || (!image && !video)) {
    return { request_id: requestId, status: 'ERROR', error: 'mock provider error', payload: null };
  }
  if (video) return { request_id: requestId, status: 'OK', payload: { video: { url: video } } };
  return { request_id: requestId, status: 'OK', payload: { images: [{ url: image! }] } };
}

export async function sendMockWebhook(webhookUrl: string, body: MockWebhookBody): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn('[fal mock] webhook answered', res.status);
  } catch (err) {
    console.error('[fal mock] webhook POST failed', err);
  }
}

export function mockSubmit({
  input,
  webhookUrl,
}: {
  input: Record<string, unknown>;
  webhookUrl: string;
}): { requestId: string } {
  const requestId = `mock-${randomUUID()}`;
  const body = mockWebhookBody(requestId, input, attemptFrom(webhookUrl));
  const delay = randomInt(MOCK_FAL_DELAY_MIN_MS, MOCK_FAL_DELAY_MAX_MS + 1);
  const deliver = () => new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => sendMockWebhook(webhookUrl, body));

  try {
    // Inside a request, after() keeps the function alive until the webhook is sent.
    after(deliver);
  } catch {
    // Outside a request scope (tests, scripts) after() throws; fire and forget instead.
    void deliver();
  }
  return { requestId };
}

/** What the mock probe reports for any clip. */
export const MOCK_VIDEO = { durationSeconds: 4, fps: 30, width: 720, height: 1280 } as const;

/**
 * The ffmpeg endpoints without fal: the probe reports MOCK_VIDEO, the re-encode returns its input,
 * and a frame grab stores a plain grey JPEG (one centred face to the mock face engine).
 */
export async function mockUtility(model: UtilityModel, input: Record<string, unknown>): Promise<unknown> {
  switch (model) {
    case FFMPEG_METADATA:
      return {
        media: {
          media_type: 'video',
          url: input.media_url,
          duration: MOCK_VIDEO.durationSeconds,
          fps: MOCK_VIDEO.fps,
          resolution: { width: MOCK_VIDEO.width, height: MOCK_VIDEO.height },
        },
      };
    case FFMPEG_MERGE: {
      const [url] = input.video_urls as string[];
      return { video: { url, content_type: 'video/mp4' }, metadata: { duration: MOCK_VIDEO.durationSeconds, fps: input.target_fps } };
    }
    case FFMPEG_EXTRACT_FRAME: {
      const jpeg = await sharp({ create: { width: MOCK_VIDEO.width / 2, height: MOCK_VIDEO.height / 2, channels: 3, background: '#808080' } })
        .jpeg()
        .toBuffer();
      const { url } = await putObject(`mock-frames/${randomUUID()}.jpg`, jpeg, 'image/jpeg');
      return { images: [{ url }] };
    }
  }
}
