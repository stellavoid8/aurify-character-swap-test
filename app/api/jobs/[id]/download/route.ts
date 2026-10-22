import { AppError, toResponse } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { fetchObject } from '@/lib/storage';
import { getCandidateForSession } from '@/server/jobs/queries';

export const runtime = 'nodejs';

/** `?candidate=<uuid>`: the version as a JPEG attachment. 404 JOB_NOT_FOUND unless it is this session's job's. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { sid } = await requireSession();
    const { id } = await params;
    const candidateId = new URL(request.url).searchParams.get('candidate') ?? '';
    const candidate = await getCandidateForSession(sid, candidateId);
    if (candidate.jobId !== id) throw new AppError('JOB_NOT_FOUND', { detail: 'candidate of another job' });
    if (candidate.status !== 'succeeded' || !candidate.imageUrl) {
      throw new AppError('INVALID_STATE', { detail: 'candidate has no image' });
    }

    const bytes = await fetchObject(candidate.imageUrl);
    const filename = `character-swap-${id.slice(0, 8)}-${candidate.rank ?? 1}.jpg`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    const res = toResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
}
