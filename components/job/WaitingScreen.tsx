'use client';

import { ArrowRight, ImageOff } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { ProgressSteps, type ProgressStep } from '@/components/ui/ProgressSteps';
import { StepIndicator } from '@/components/ui/StepIndicator';
import { ELAPSED_ANNOUNCE_MS } from '@/lib/limits';
import { skipOptimizer } from '@/lib/image-src';
import type { JobStage, JobView } from '@/lib/types';

const STEPS: { label: string; stage: JobStage }[] = [
  { label: 'Looking at your template', stage: 'analyzing' },
  { label: 'Swapping you in', stage: 'generating' },
  { label: 'Checking the likeness', stage: 'ranking' },
];

/**
 * Try again rounds reuse the template analysis, so they skip its step and say the picture is new.
 * The exception is a retry after the analysis itself failed: that round analyzes again.
 * Fix the face rounds never show this screen; the result screen shows their progress.
 */
function progressSteps(stage: JobStage, round: number): ProgressStep[] {
  const steps =
    round > 1 && stage !== 'analyzing'
      ? STEPS.slice(1).map((s) => (s.stage === 'generating' ? { ...s, label: 'Swapping you in again' } : s))
      : STEPS;
  const current = stage === 'done' ? steps.length : Math.max(0, steps.findIndex((s) => s.stage === stage));
  return steps.map(({ label }, i) => ({ label, state: i < current ? 'done' : i === current ? 'active' : 'todo' }));
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
  return (
    <Image src={url} alt={alt} unoptimized={skipOptimizer(url)} width={112} height={112} sizes="(min-width: 768px) 112px, 80px" className="size-20 rounded-md object-cover md:size-28" />
  );
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
        <ProgressSteps steps={progressSteps(view.stage, view.round)} />
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
