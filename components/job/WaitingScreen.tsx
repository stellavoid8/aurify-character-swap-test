'use client';

import { ArrowRight, ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { ProgressSteps, type ProgressStep } from '@/components/ui/ProgressSteps';
import { StepIndicator } from '@/components/ui/StepIndicator';
import { ELAPSED_ANNOUNCE_MS } from '@/lib/limits';
import type { JobStage, JobView } from '@/lib/types';

const STEPS: { label: string; stage: JobStage }[] = [
  { label: 'Looking at your template', stage: 'analyzing' },
  { label: 'Making 3 versions', stage: 'generating' },
  { label: 'Picking the best match', stage: 'ranking' },
];

function progressSteps(stage: JobStage): ProgressStep[] {
  // TODO(prompt 15): refinement rounds get their own step.
  const current = stage === 'done' ? STEPS.length : Math.max(0, STEPS.findIndex((s) => s.stage === stage));
  return STEPS.map(({ label }, i) => ({ label, state: i < current ? 'done' : i === current ? 'active' : 'todo' }));
}

/** 42_000 → "0:42" */
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function spokenDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const parts = [minutes > 0 && `${minutes} minute${minutes === 1 ? '' : 's'}`, rest > 0 && `${rest} seconds`].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'less than a minute';
}

function Thumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <div role="img" aria-label={alt} className="flex size-20 items-center justify-center rounded-md bg-surface-2 text-ink-muted md:size-28">
        <ImageOff aria-hidden className="size-6" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- stored photos of unknown size
  return <img src={url} alt={alt} className="size-20 rounded-md object-cover md:size-28" />;
}

export function WaitingScreen({ view, receivedAt }: { view: JobView; receivedAt: number }) {
  const [now, setNow] = useState(receivedAt);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [receivedAt]);

  const elapsedMs = view.elapsedMs + Math.max(0, now - receivedAt);
  const announcedMs = Math.floor(elapsedMs / ELAPSED_ANNOUNCE_MS) * ELAPSED_ANNOUNCE_MS;
  const etaMinutes = Math.max(1, Math.round(view.etaMs / 60_000));
  const mainPhoto = view.userPhotos.find((p) => p.isReference) ?? view.userPhotos[0];

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <StepIndicator current={3} />

      <div className="flex items-center gap-3">
        <Thumb url={view.template.url} alt="Your template" />
        <ArrowRight aria-hidden className="size-5 text-ink-muted" />
        <Thumb url={mainPhoto?.url ?? null} alt="Your photo" />
      </div>

      <h1 className="font-display text-title">Making your picture</h1>

      <div aria-live="polite" className="w-full max-w-xs text-left">
        <ProgressSteps steps={progressSteps(view.stage)} />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-body tabular-nums" aria-hidden suppressHydrationWarning>
          {clock(elapsedMs)}
        </p>
        <p className="sr-only">Time so far: {spokenDuration(announcedMs)}</p>
        <p className="text-small text-ink-muted">
          {elapsedMs > view.etaMs ? 'Taking a little longer than usual…' : `Usually about ${etaMinutes} min`}
        </p>
      </div>

      {view.notices.length > 0 && (
        <div className="flex w-full flex-col gap-2 text-left">
          {view.notices.map((notice, i) => (
            <Notice key={`${notice.code}-${i}`} tone="info">
              {notice.message}
            </Notice>
          ))}
        </div>
      )}

      <p className="text-caption text-ink-muted">You can leave this page open. Your picture will appear here.</p>
    </div>
  );
}
