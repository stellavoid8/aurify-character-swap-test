import { ButtonLink } from '@/components/ui/Button';
import { StepIndicator } from '@/components/ui/StepIndicator';
import type { JobView } from '@/lib/types';

// TODO(prompt 14): the full result screen (compare, other versions, download, share, fix face).
export function ResultView({ view }: { view: JobView }) {
  const chosen = view.candidates.find((c) => c.id === view.chosenCandidateId);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 text-center">
      <StepIndicator current={3} />
      <h1 className="font-display text-title">Your picture is ready</h1>
      {chosen?.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- stored results of unknown size
        <img src={chosen.imageUrl} alt="Your picture" className="w-full rounded-lg bg-surface-2 object-contain" />
      )}
      <ButtonLink href="/" size="lg">
        Make another
      </ButtonLink>
    </div>
  );
}
