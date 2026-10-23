import { Spinner } from '@/components/ui/Spinner';

export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-3 px-4 py-24 md:px-8">
      <Spinner size="lg" label="Loading" className="text-accent" />
    </main>
  );
}
