'use client';

import { Download, ImageOff, RefreshCw, ScanFace } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, buttonStyles } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { ErrorPanel } from '@/components/ui/ErrorPanel';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { StepIndicator } from '@/components/ui/StepIndicator';
import { cn } from '@/lib/cn';
import { ERRORS } from '@/lib/errors';
import { skipOptimizer } from '@/lib/image-src';
import { MAX_ROUNDS_PER_JOB } from '@/lib/limits';
import type { CandidateView, FaceBox, JobView } from '@/lib/types';
import { chooseCandidate, refineCandidate } from '@/server/jobs/actions';
import { CandidateStrip, stripOrder } from './CandidateStrip';
import { likenessPct, versionLabel } from './labels';
import { CompareSlider } from './CompareSlider';
import type { RoundStarted } from './JobScreen';
import { ShareButton } from './ShareButton';
import { StartOverLink } from './StartOverLink';
import { SubjectNotice } from './SubjectNotice';

const IMAGE = 'block h-auto w-full max-h-[70vh] rounded-md bg-surface-2 object-contain md:max-h-[calc(100dvh-17rem)]';
/** Stand-in pixel size for stored photos: `next/image` needs one, and `h-auto` lets the real aspect ratio win once loaded. */
const UNKNOWN_SIZE = 1024;
const BOX_STROKES = [
  { color: 'stroke-accent-ink', strokeWidth: 5 },
  { color: 'stroke-accent', strokeWidth: 2 },
] as const;

type CompareCellProps = {
  caption: string;
  url: string | null;
  alt: string;
  className?: string;
  /** Template only: the swapped person, outlined. Needs the image's pixel size to line up. */
  box?: { box: FaceBox['box']; width: number; height: number } | null;
  /** Covers the picture, e.g. while Fix the face runs. */
  overlay?: ReactNode;
  /** The cell's rendered width, for `next/image`. */
  sizes: string;
  priority?: boolean;
};

function CompareCell({ caption, url, alt, className, box, overlay, sizes, priority }: CompareCellProps) {
  return (
    <Card as="figure" className={cn('flex min-w-0 flex-col gap-2', className)}>
      <figcaption className="text-caption text-ink-muted">{caption}</figcaption>
      {url ? (
        <div className="relative">
          <Image
            src={url}
            alt={alt}
            width={box?.width ?? UNKNOWN_SIZE}
            height={box?.height ?? UNKNOWN_SIZE}
            sizes={sizes}
            priority={priority}
            unoptimized={skipOptimizer(url)}
            className={IMAGE}
          />
          {box && (
            // Same aspect fit as object-contain, so the box lands on the face at any cell size.
            <svg
              aria-hidden
              viewBox={`0 0 ${box.width} ${box.height}`}
              preserveAspectRatio="xMidYMid meet"
              className="pointer-events-none absolute inset-0 size-full"
            >
              {/* A light halo under the accent line keeps the marker visible on dark or blue photos. */}
              {BOX_STROKES.map(({ color, strokeWidth }) => (
                <rect
                  key={color}
                  x={box.box[0] * box.width}
                  y={box.box[1] * box.height}
                  width={box.box[2] * box.width}
                  height={box.box[3] * box.height}
                  rx={4}
                  fill="none"
                  strokeWidth={strokeWidth}
                  vectorEffect="non-scaling-stroke"
                  className={color}
                />
              ))}
            </svg>
          )}
          {overlay}
        </div>
      ) : (
        <div role="img" aria-label={alt} className="flex aspect-square items-center justify-center rounded-md bg-surface-2 text-ink-muted">
          <ImageOff aria-hidden className="size-6" />
        </div>
      )}
    </Card>
  );
}

/** The job's choice, else the latest round's best match, else the newest finished version. */
function defaultChoice(view: JobView, items: CandidateView[]): string | null {
  if (items.some((c) => c.id === view.chosenCandidateId)) return view.chosenCandidateId;
  return (items.find((c) => c.round === items[0]?.round && c.rank === 1) ?? items[0])?.id ?? null;
}

const DESKTOP = '(min-width: 48rem)';
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
/** True at Tailwind's `md` breakpoint and up. False on the server: the panel only opens after a round. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP).matches, () => false);
}

type RefinementPanelProps = {
  before: CandidateView;
  after: CandidateView;
  onKeepFixed: () => void;
  onKeepOriginal: () => void;
  /** A Dialog on phones; an inline Card beside the result on desktop. */
  inline: boolean;
};

function RefinementPanel({ before, after, onKeepFixed, onKeepOriginal, inline }: RefinementPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The inline card appears without a focus trap; move focus to it so keyboard and screen-reader users land there.
  useEffect(() => {
    if (inline) heading.current?.focus();
  }, [inline]);

  const lower = before.identityScore !== null && after.identityScore !== null && after.identityScore < before.identityScore;
  const body = (
    <>
      <CompareSlider beforeUrl={before.imageUrl!} afterUrl={after.imageUrl!} beforeAlt="Before the fix" afterAlt="After the fix" />
      <p className="text-small text-ink-muted">
        Likeness: before {likenessPct(before.identityScore)} · after {likenessPct(after.identityScore)}
      </p>
      {lower && <Notice tone="warning">The fix made the likeness lower this time. We recommend keeping the original.</Notice>}
    </>
  );
  const buttons = (
    <>
      <Button variant="secondary" onClick={onKeepOriginal}>
        Keep the original
      </Button>
      <Button onClick={onKeepFixed}>Keep the fixed face</Button>
    </>
  );

  if (!inline) {
    return (
      <Dialog open onClose={onKeepOriginal} title="Before and after" footer={buttons}>
        {body}
      </Dialog>
    );
  }
  return (
    <Card as="section" aria-labelledby="before-after" className="flex min-w-0 flex-col gap-4">
      <h2 id="before-after" ref={heading} tabIndex={-1} className="text-heading focus:outline-none">
        Before and after
      </h2>
      {body}
      <div className="flex flex-wrap justify-end gap-2">{buttons}</div>
    </Card>
  );
}

type ResultViewProps = {
  view: JobView;
  /** Called once Try again or Fix the face has started a round. */
  onRoundStarted: RoundStarted;
  onRetry: () => void;
  retrying: boolean;
  /** Shown above the result, e.g. a lost connection while Fix the face runs. */
  notice?: ReactNode;
};

/** Step 3 once the job succeeded: the comparison, Download and Share, the other versions, Try again and Fix the face. */
export function ResultView({ view, onRoundStarted, onRetry, retrying, notice }: ResultViewProps) {
  const items = stripOrder(view.candidates);
  const [chosenId, setChosenId] = useState(() => defaultChoice(view, items));
  // A new view from the server (another round finished) resets the choice to what it says.
  const [serverChoice, setServerChoice] = useState(view.chosenCandidateId);
  if (serverChoice !== view.chosenCandidateId) {
    setServerChoice(view.chosenCandidateId);
    setChosenId(defaultChoice(view, items));
  }

  // Choices are saved one at a time, latest wins; a failure reverts only if no newer choice is waiting.
  const saved = useRef(chosenId);
  const queued = useRef<string | null>(null);
  const saving = useRef(false);

  async function flush() {
    if (saving.current) return;
    saving.current = true;
    while (queued.current) {
      const candidateId = queued.current;
      queued.current = null;
      const result = await chooseCandidate({ jobId: view.id, candidateId }).catch(() => null);
      if (result?.ok) saved.current = candidateId;
      else if (!queued.current) {
        setChosenId(saved.current);
        toast.error(result?.error.message ?? ERRORS.INTERNAL_ERROR.message);
      }
    }
    saving.current = false;
  }

  function choose(candidateId: string) {
    setChosenId(candidateId);
    if (candidateId === saved.current && !saving.current) return;
    queued.current = candidateId;
    void flush();
  }

  const refining = view.status === 'running' && view.stage === 'refining';
  const [starting, setStarting] = useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  const isDesktop = useIsDesktop();
  const fixButton = useRef<HTMLButtonElement>(null);
  const sectionHeading = useRef<HTMLHeadingElement>(null);

  // When a Fix the face round ends: open before/after on success, say so on failure. Also works
  // after a reload mid-round, since the stage comes from the server.
  const lastStage = useRef(view.stage);
  useEffect(() => {
    const was = lastStage.current;
    lastStage.current = view.stage;
    if (was !== 'refining' || view.stage === 'refining') return;
    const refined = view.candidates.find((c) => c.kind === 'refinement' && c.round === view.round);
    if (refined?.status === 'succeeded' && refined.imageUrl) setPanelId(refined.id);
    else toast.error(ERRORS.REFINEMENT_FAILED.message);
  }, [view]);

  async function fixFace(candidateId: string) {
    setStarting(true);
    const result = await refineCandidate({ jobId: view.id, candidateId }).catch(() => null);
    if (result?.ok) await onRoundStarted('refining');
    else toast.error(result?.error.message ?? ERRORS.INTERNAL_ERROR.message);
    setStarting(false);
  }

  function closePanel() {
    setPanelId(null);
    // After the dialog has closed and restored focus itself, hand it to Fix the face (or its section).
    requestAnimationFrame(() => (fixButton.current ?? sectionHeading.current)?.focus());
  }

  const chosenIndex = items.findIndex((c) => c.id === chosenId);
  const chosen = items[chosenIndex];
  if (!chosen?.imageUrl) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-2">
        <ErrorPanel code="GENERATION_FAILED" onRetry={view.canRetry ? onRetry : undefined} retryLoading={retrying} />
        <StartOverLink />
      </div>
    );
  }

  const { template } = view;
  const multiPerson = template.peopleCount !== null && template.peopleCount > 1;
  const userPhoto = view.userPhotos.find((p) => p.isReference) ?? view.userPhotos[0];
  const notices = view.notices.filter((n) => !(multiPerson && n.code === 'TEMPLATE_MULTIPLE_PEOPLE'));
  const downloadUrl = `/api/jobs/${view.id}/download?candidate=${chosen.id}`;
  const filename = `character-swap-${view.id.slice(0, 8)}-${chosen.rank ?? 1}.jpg`;

  const refined = panelId ? view.candidates.find((c) => c.id === panelId) : undefined;
  const parent = refined && view.candidates.find((c) => c.id === refined.parentCandidateId);
  const panel =
    refined?.imageUrl && parent?.imageUrl ? (
      <RefinementPanel
        before={parent}
        after={refined}
        inline={isDesktop}
        onKeepOriginal={closePanel}
        onKeepFixed={() => {
          choose(refined.id);
          closePanel();
        }}
      />
    ) : null;
  const inlinePanel = panel !== null && isDesktop;

  const roundsUsed = view.round >= MAX_ROUNDS_PER_JOB;
  const busy = refining || starting || retrying;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col items-center gap-4 md:flex-row md:justify-between">
        <StepIndicator current={3} />
        <h1 className="text-center font-display text-title md:order-first md:text-left">Here&apos;s your picture</h1>
      </div>
      {notice}

      {/* Large screens: the pictures on the left, what to do with them on the right, so it all fits one screen. */}
      <div className="flex min-w-0 flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Result first in reading order and on phones; last (on the right) on desktop. */}
          <div className={cn('grid grid-cols-2 gap-4', inlinePanel ? 'md:grid-cols-2' : 'md:grid-cols-3')}>
            <CompareCell
              caption={`Result · ${versionLabel(chosen)} · likeness ${likenessPct(chosen.identityScore)}`}
              url={chosen.imageUrl}
              alt={`Your result, version ${chosenIndex + 1}`}
              className="col-span-2 md:order-last md:col-span-1 md:ring-2 md:ring-accent"
              sizes="(min-width: 768px) 480px, 100vw"
              priority
              overlay={
                refining && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-surface/80">
                    <Spinner size="lg" className="text-accent" />
                    <p role="status" className="text-body font-semibold">
                      Fixing the face…
                    </p>
                  </div>
                )
              }
            />
            {inlinePanel ? (
              panel
            ) : (
              <>
                <CompareCell
                  caption="Template"
                  url={template.url}
                  alt="Template photo"
                  sizes="(min-width: 768px) 320px, 50vw"
                  box={
                    multiPerson && template.subjectBox && template.width > 0 && template.height > 0
                      ? { box: template.subjectBox, width: template.width, height: template.height }
                      : null
                  }
                />
                <CompareCell caption="Your photo" url={userPhoto?.url ?? null} alt="Your photo" sizes="(min-width: 768px) 320px, 50vw" />
              </>
            )}
          </div>
          {!isDesktop && panel}

          <SubjectNotice peopleCount={template.peopleCount} subjectLabel={template.subjectLabel} />
          {notices.map((n, i) => (
            <Notice key={`${n.code}-${i}`} tone={n.code === 'REFINEMENT_FAILED' ? 'warning' : 'info'}>
              {n.message}
            </Notice>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row lg:flex-wrap">
            <a href={downloadUrl} download={filename} className={buttonStyles({ size: 'lg' })}>
              <Download aria-hidden className="size-4" />
              Download
            </a>
            <ShareButton downloadUrl={downloadUrl} imageUrl={chosen.imageUrl} filename={filename} />
          </div>

          <section aria-labelledby="not-quite-right" className="flex flex-col gap-3 rounded-lg border border-line bg-surface/60 p-4 backdrop-blur-md md:p-5">
            <h2 id="not-quite-right" ref={sectionHeading} tabIndex={-1} className="text-heading focus:outline-none">
              Not quite right?
            </h2>
            {roundsUsed && !refining ? (
              <>
                <p className="text-small text-ink-muted">
                  You&apos;ve made as many versions of this picture as we allow. Start a new picture to keep going.
                </p>
                <div>
                  <StartOverLink />
                </div>
              </>
            ) : view.unitsLeftToday === 0 && !refining ? (
              <Notice tone="warning" title={ERRORS.RATE_LIMITED_SESSION.message}>
                {ERRORS.RATE_LIMITED_SESSION.nextStep}
              </Notice>
            ) : (
              <>
                <p className="text-small text-ink-muted">
                  Try again makes a new version. Fix the face sharpens your likeness on this one.
                </p>
                <div className="flex flex-col gap-3 md:flex-row lg:flex-wrap">
                  <Button variant="secondary" size="lg" onClick={onRetry} loading={retrying} disabled={busy || !view.canRetry}>
                    {!retrying && <RefreshCw aria-hidden className="size-4" />}
                    Try again
                  </Button>
                  <Button
                    ref={fixButton}
                    variant="secondary"
                    size="lg"
                    onClick={() => void fixFace(chosen.id)}
                    loading={starting || refining}
                    disabled={busy || !view.canRefine}
                  >
                    {!(starting || refining) && <ScanFace aria-hidden className="size-4" />}
                    Fix the face
                  </Button>
                </div>
              </>
            )}
          </section>

          <CandidateStrip candidates={view.candidates} chosenId={chosen.id} onChoose={choose} />

          <div className="flex justify-center lg:justify-start">
            <StartOverLink />
          </div>
        </div>
      </div>
    </div>
  );
}
