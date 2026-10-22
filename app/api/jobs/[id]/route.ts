import { toResponse } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { getJobView } from '@/server/jobs/view';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Polled by the waiting screen: `{ data: JobView }`, or 404 JOB_NOT_FOUND for another session's job. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { sid } = await requireSession();
    const { id } = await params;
    return Response.json({ data: await getJobView(sid, id) }, { headers: NO_STORE });
  } catch (err) {
    const res = toResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
}
