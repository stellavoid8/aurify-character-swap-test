'use client';

import { useEffect } from 'react';
import { ErrorPanel } from '@/components/ui/ErrorPanel';
import { useSwapFlow } from '@/stores/swap-flow';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <ErrorPanel
        code="INTERNAL_ERROR"
        retryLabel="Start again"
        onRetry={() => {
          useSwapFlow.getState().reset();
          reset();
        }}
      />
    </main>
  );
}
