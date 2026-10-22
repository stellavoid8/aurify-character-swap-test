import { after } from 'next/server';
import { db } from '@/lib/db';
import { webhookEvents } from '@/lib/db/schema';
import { AppError, toResponse } from '@/lib/errors';
import { FalWebhookBody, handleFalWebhook } from '@/lib/pipeline/fan-in';
import { verifyWebhookToken } from '@/lib/webhook-token';

export const runtime = 'nodejs';
// The response returns at once; this covers the after() result copy, retry submit and fan-in.
export const maxDuration = 60;

/**
 * fal's completion callback, at the per-candidate URL from `webhookUrlFor`. Answers 200 quickly
 * so fal doesn't retry; a replay of an event already recorded changes nothing.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const cid = params.get('cid') ?? '';
    const attempt = Number(params.get('a'));
    // Checked before the body is read, so an unsigned caller costs no parsing and no db write.
    if (!verifyWebhookToken(cid, attempt, params.get('t') ?? '')) throw new AppError('WEBHOOK_UNAUTHORIZED');

    const raw = await request.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AppError('VALIDATION_FAILED', { detail: 'webhook body is not JSON' });
    }
    const body = FalWebhookBody.parse(json);

    const inserted = await db
      .insert(webhookEvents)
      .values({ provider: 'fal', requestId: body.request_id, candidateId: cid, status: body.status })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (inserted.length === 0) return Response.json({ data: { duplicate: true } });

    after(() => handleFalWebhook({ cid, attempt, body }));
    return Response.json({ data: { received: true } });
  } catch (err) {
    return toResponse(err);
  }
}
