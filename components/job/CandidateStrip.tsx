'use client';

import { Fragment, useRef, type KeyboardEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { CandidateView } from '@/lib/types';

type CandidateStripProps = {
  /** Every candidate of the job, as the view orders them (round, then rank). */
  candidates: CandidateView[];
  chosenId: string | null;
  onChoose: (candidateId: string) => void;
};

/** Succeeded candidates, newest round first, keeping rank order within a round. */
export function stripOrder(candidates: CandidateView[]): CandidateView[] {
  return candidates
    .filter((c) => c.status === 'succeeded' && c.imageUrl)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.round - a.c.round || a.i - b.i)
    .map(({ c }) => c);
}

const NEXT_KEYS = ['ArrowRight', 'ArrowDown'];
const PREV_KEYS = ['ArrowLeft', 'ArrowUp'];

/**
 * "Other versions": a radio group of thumbnails. Arrow keys move and choose, like any radio group.
 * Versions from before the latest Try again sit after an "Earlier versions" divider; Fix the face
 * results made since then count as current.
 */
export function CandidateStrip({ candidates, chosenId, onChoose }: CandidateStripProps) {
  const items = stripOrder(candidates);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (items.length === 0) return null;

  const latestRound = items[0].round;
  const latest = candidates.filter((c) => c.round === latestRound && c.status !== 'pending');
  const finished = latest.filter((c) => c.status === 'succeeded').length;
  const focusIndex = Math.max(0, items.findIndex((c) => c.id === chosenId));
  const latestGeneration = Math.max(0, ...items.filter((c) => c.kind === 'generation').map((c) => c.round));
  const isEarlier = (c: CandidateView) => c.round < latestGeneration;
  const firstEarlier = items.findIndex(isEarlier);

  function onKeyDown(event: KeyboardEvent, index: number) {
    let next: number;
    if (NEXT_KEYS.includes(event.key)) next = (index + 1) % items.length;
    else if (PREV_KEYS.includes(event.key)) next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChoose(items[next].id);
  }

  return (
    <section aria-labelledby="other-versions" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="other-versions" className="text-heading">
          Other versions
        </h2>
        {finished < latest.length && (
          <p className="text-small text-ink-muted">
            {finished} of {latest.length} versions finished
          </p>
        )}
      </div>
      <div role="radiogroup" aria-label="Versions" className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 py-1">
        {items.map((c, index) => {
          const selected = c.id === chosenId;
          const best = c.kind === 'generation' && c.round === latestGeneration && c.rank === 1;
          return (
            <Fragment key={c.id}>
              {index === firstEarlier && index > 0 && (
                // Visual only: each earlier thumbnail says so in its own name.
                <div aria-hidden className="flex shrink-0 items-center self-stretch border-l border-line pl-3 text-caption text-ink-muted">
                  Earlier versions
                </div>
              )}
              <button
                ref={(el) => {
                  refs.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={index === focusIndex ? 0 : -1}
                onClick={() => onChoose(c.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className="flex shrink-0 snap-start flex-col items-center gap-1.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- stored results of unknown size */}
                <img
                  src={c.imageUrl!}
                  alt={`Your result, version ${index + 1}${isEarlier(c) ? ', earlier' : ''}`}
                  className={cn('size-20 rounded-md bg-surface-2 object-cover md:size-24', selected && 'ring-2 ring-accent')}
                />
                {best && <Badge tone="accent">Best match</Badge>}
                {c.kind === 'refinement' && <Badge tone="success">Fixed face</Badge>}
              </button>
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
