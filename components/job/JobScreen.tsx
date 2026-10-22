'use client';

import { useEffect, useRef, useState } from 'react';
import { ErrorPanel } from '@/components/ui/ErrorPanel';
import { Notice } from '@/components/ui/Notice';
import { POLL_BACKOFF_MS, POLL_INTERVAL_MS, POLL_MAX_ERRORS } from '@/lib/limits';
import type { ApiResponse, JobView } from '@/lib/types';
import { ResultView } from './ResultView';
import { StartOverLink } from './StartOverLink';
import { WaitingScreen } from './WaitingScreen';

const isActive = (view: JobView) => view.status === 'queued' || view.status === 'running';

/**
 * Step 3. Polls the job view while the picture is being made (paused while the tab is hidden,
 * refreshed as soon as it is shown again), then shows the result or the error.
 */
export function JobScreen({ initial }: { initial: JobView }) {
  const [view, setView] = useState(initial);
  // When `view` arrived, so the timer can count on from its elapsedMs.
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [connectionLost, setConnectionLost] = useState(false);
  const failures = useRef(0);
  const active = isActive(view);
  const jobId = view.id;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      if (cancelled || document.hidden) return;
      timer = setTimeout(poll, failures.current >= POLL_MAX_ERRORS ? POLL_BACKOFF_MS : POLL_INTERVAL_MS);
    };

    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        const body = (await res.json()) as ApiResponse<JobView>;
        if (!('data' in body)) throw new Error(body.error.code);
        if (cancelled) return;
        failures.current = 0;
        setConnectionLost(false);
        setView(body.data);
        setReceivedAt(Date.now());
      } catch {
        if (cancelled) return;
        failures.current += 1;
        if (failures.current >= POLL_MAX_ERRORS) setConnectionLost(true);
      } finally {
        inFlight = false;
      }
      schedule();
    }

    const onVisibility = () => {
      if (document.hidden) clearTimeout(timer);
      else void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, jobId]);

  if (active) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        {connectionLost && <Notice tone="warning">Connection lost. We&apos;ll keep trying.</Notice>}
        <WaitingScreen view={view} receivedAt={receivedAt} />
      </div>
    );
  }

  if (view.status === 'succeeded') return <ResultView view={view} />;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-2">
      {/* TODO(prompt 15): wire Try again to retryJob. */}
      <ErrorPanel code={view.error?.code ?? 'INTERNAL_ERROR'} retryDisabled />
      <StartOverLink />
    </div>
  );
}
