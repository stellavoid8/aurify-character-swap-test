import { CreateFlow } from '@/components/swap/CreateFlow';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/session';

// normalizeUpload runs as a Server Action in this segment: fetch, HEIC conversion and face checks,
// and for a template clip the probe, re-encode and frame grabs on fal (VIDEO_UTILITY_TIMEOUT_MS each).
export const maxDuration = 120;

export default async function CreatePage() {
  // `sid` only builds upload pathnames; the signed cookie is what authorizes them.
  const { sid } = await requireSession();
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 md:px-8 md:py-6">
      <CreateFlow sid={sid} videoEnabled={env.VIDEO_ENABLED} />
    </main>
  );
}
