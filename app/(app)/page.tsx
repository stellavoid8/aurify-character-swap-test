import { AppHeader } from '@/components/ui/AppHeader';
import { Card } from '@/components/ui/Card';
import { StepIndicator } from '@/components/ui/StepIndicator';

// TODO(prompt 9): placeholder until the create flow and the (app) layout land.
export default function CreatePage() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8">
        <StepIndicator current={1} />
        <Card>
          <h1 className="font-display text-title">Pick a template photo</h1>
          <p className="mt-2 text-body text-ink-muted">The upload step is coming next.</p>
        </Card>
      </main>
    </>
  );
}
