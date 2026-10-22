import { after } from 'next/server';
import { AppError, toResponse } from '@/lib/errors';
import { runGenerationRound } from '@/lib/pipeline/generate';
import { requireSession } from '@/lib/session';
import { createJob } from '@/server/jobs/create';

export const runtime = 'nodejs';
// The response returns in under a second; this covers the after() analysis and fal submissions.
export const maxDuration = 60;

/** Starts a picture: 201 `{ data: { jobId } }`, then analysis and generation continue in after(). */
export async function POST(request: Request): Promise<Response> {
  const started = performance.now();
  try {
    const { sid } = await requireSession();
    const body = await request.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', { detail: 'body is not JSON' });
    });
    const { jobId, roundId } = await createJob(sid, body);
    after(() => runGenerationRound({ jobId, roundId }));
    console.info('[jobs] created', { jobId, ms: Math.round(performance.now() - started) });
    return Response.json({ data: { jobId } }, { status: 201 });
  } catch (err) {
    return toResponse(err);
  }
}
