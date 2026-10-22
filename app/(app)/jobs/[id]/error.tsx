'use client';

import { useEffect } from 'react';
import { ErrorPanel } from '@/components/ui/ErrorPanel';

export default function JobError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <ErrorPanel code="INTERNAL_ERROR" retryLabel="Reload" onRetry={() => window.location.reload()} />
    </main>
  );
}
