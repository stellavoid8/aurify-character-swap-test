import { CreateFlow } from '@/components/swap/CreateFlow';
import { requireSession } from '@/lib/session';

// normalizeUpload runs as a Server Action in this segment: fetch, HEIC conversion and face checks.
export const maxDuration = 30;

export default async function CreatePage() {
  // `sid` only builds upload pathnames; the signed cookie is what authorizes them.
  const { sid } = await requireSession();
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <CreateFlow sid={sid} />
    </main>
  );
}
