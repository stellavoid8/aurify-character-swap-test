import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

// TODO(prompts 13–14): replace with the waiting and result screens (getJobView + polling).
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <Card className="flex flex-col items-center gap-4 text-center">
        <Spinner />
        <h1 className="font-display text-title">Making your picture</h1>
        <p className="text-small text-ink-muted">Picture {id}</p>
      </Card>
    </main>
  );
}
