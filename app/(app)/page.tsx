import { Card } from '@/components/ui/Card';
import { StepIndicator } from '@/components/ui/StepIndicator';

// TODO(prompt 9): placeholder until the create flow lands.
export default function CreatePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8">
      <StepIndicator current={1} />
      <Card>
        <h1 className="font-display text-title">Step 1 coming next</h1>
        <p className="mt-2 text-body text-ink-muted">The template upload step is on its way.</p>
      </Card>
    </main>
  );
}
