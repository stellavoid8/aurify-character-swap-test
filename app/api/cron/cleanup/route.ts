import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { AppError, toResponse } from '@/lib/errors';
import { runCleanup } from '@/server/cron/cleanup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(header: string | null): boolean {
  const given = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  // Length check first: timingSafeEqual throws on unequal lengths. The length is not secret.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Vercel Cron, daily (vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request): Promise<Response> {
  try {
    if (!authorized(request.headers.get('authorization'))) throw new AppError('CRON_UNAUTHORIZED');
    return Response.json({ data: await runCleanup() });
  } catch (err) {
    return toResponse(err);
  }
}
