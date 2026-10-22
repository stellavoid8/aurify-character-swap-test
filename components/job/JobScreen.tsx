'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ErrorPanel } from '@/components/ui/ErrorPanel';
import { Notice } from '@/components/ui/Notice';
import { ERRORS } from '@/lib/errors';
import { POLL_BACKOFF_MS, POLL_INTERVAL_MS, POLL_MAX_ERRORS } from '@/lib/limits';
import type { ApiResponse, JobStage, JobView } from '@/lib/types';
import { retryJob } from '@/server/jobs/actions';
import { ResultView } from './ResultView';
import { StartOverLink } from './StartOverLink';
import { WaitingScreen } from './WaitingScreen';

const isActive = (view: JobView) => view.status === 'queued' || view.status === 'running';

async function fetchView(jobId: string): Promise<JobView> {
  const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
  const body = (await res.json()) as ApiResponse<JobView>;
  if (!('data' in body)) throw new Error(body.error.code);
  return body.data;
}

/** What the screen does after Try again or Fix the face has started a round. */
export type RoundStarted = (stage: Extract<JobStage, 'generating' | 'refining'>) => Promise<void>;

/**
 * Step 3. Polls the job view while the picture is being made (paused while the tab is hidden,
 * refreshed as soon as it is shown again), then shows the result or the error. A Fix the face
 * round stays on the result screen, which shows its own progress over the picture.
 */
export function JobScreen({ initial }: { initial: JobView }) {
  const [view, setView] = useState(initial);
  // When `view` arrived, so the timer can count on from its elapsedMs.
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [connectionLost, setConnectionLost] = useState(false);
  const failures = useRef(0);
  const active = isActive(view);
  const jobId = view.id;
  const [retrying, setRetrying] = useState(false);

  /** Loads the new round's view at once, so the screen switches without waiting for a poll. */
  const onRoundStarted = useCallback<RoundStarted>(
    async (stage) => {
      try {
        setView(await fetchView(jobId));
      } catch {
        // The poll catches up; until then, show the round as started.
        setView((v) => ({ ...v, status: 'running', stage, round: v.round + 1, elapsedMs: 0, error: null }));
      }
      setReceivedAt(Date.now());
    },
    [jobId],
  );

  async function retry() {
    setRetrying(true);
    const result = await retryJob({ jobId }).catch(() => null);
    if (result?.ok) await onRoundStarted('generating');
    else {
      toast.error(result?.error.message ?? ERRORS.INTERNAL_ERROR.message);
      // The limits may have changed (e.g. the daily units ran out); show what is possible now.
      await fetchView(jobId).then(setView, () => undefined);
    }
    setRetrying(false);
  }

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
        const next = await fetchView(jobId);
        if (cancelled) return;
        failures.current = 0;
        setConnectionLost(false);
        setView(next);
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

  const lostNotice = connectionLost && <Notice tone="warning">Connection lost. We&apos;ll keep trying.</Notice>;

  if (active && view.stage !== 'refining') {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        {lostNotice}
        <WaitingScreen view={view} receivedAt={receivedAt} />
      </div>
    );
  }

  // One element for refining and succeeded, so the result screen keeps its state across the round.
  if (active || view.status === 'succeeded') {
    return <ResultView view={view} onRoundStarted={onRoundStarted} onRetry={retry} retrying={retrying} notice={lostNotice} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-2">
      <ErrorPanel
        code={view.error?.code ?? 'INTERNAL_ERROR'}
        onRetry={view.canRetry ? retry : undefined}
        retryLoading={retrying}
      />
      {!view.canRetry && view.unitsLeftToday === 0 && (
        <Notice tone="warning" title={ERRORS.RATE_LIMITED_SESSION.message} className="w-full">
          {ERRORS.RATE_LIMITED_SESSION.nextStep}
        </Notice>
      )}
      <StartOverLink />
    </div>
  );
}
