import { StepIndicator } from '@/components/ui/StepIndicator';

export default function JobLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
        <StepIndicator current={3} />
        <div className="flex items-center gap-3" aria-busy="true">
          <span className="sr-only">Loading your picture</span>
          <div className="size-20 animate-pulse rounded-md bg-surface-2 md:size-28" />
          <div className="size-20 animate-pulse rounded-md bg-surface-2 md:size-28" />
        </div>
      </div>
    </main>
  );
}
