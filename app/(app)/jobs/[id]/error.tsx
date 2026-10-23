'use client';

import { useEffect } from 'react';
import { ErrorPanel } from '@/components/ui/ErrorPanel';

export default function JobError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-5 md:px-8 md:py-6">
      <ErrorPanel code="INTERNAL_ERROR" retryLabel="Reload" onRetry={() => window.location.reload()} />
    </main>
  );
}
