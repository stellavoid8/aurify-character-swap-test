import { StepIndicator } from '@/components/ui/StepIndicator';

export default function JobLoading() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-5 md:px-8 md:py-6">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
        <StepIndicator current={3} />
        <div className="flex items-center gap-3" aria-busy="true">
          <span className="sr-only">Loading your picture</span>
          <div className="size-20 animate-pulse rounded-md motion-reduce:animate-none bg-surface-2 md:size-28" />
          <div className="size-20 animate-pulse rounded-md motion-reduce:animate-none bg-surface-2 md:size-28" />
        </div>
      </div>
    </main>
  );
}
