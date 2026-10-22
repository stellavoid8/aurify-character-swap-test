'use client';

import { ChevronsLeftRight } from 'lucide-react';
import Image from 'next/image';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { skipOptimizer } from '@/lib/image-src';

const STEP = 5;
const IMAGE = 'col-start-1 row-start-1 block h-auto w-full max-h-[60vh] rounded-md object-contain';
/** Full width in the phone dialog, the inline card's width on desktop. */
const SIZES = '(min-width: 768px) 480px, 100vw';
/** Stand-in pixel size: both results share the real aspect ratio, which `h-auto` applies once loaded. */
const UNKNOWN_SIZE = 1024;
const LABEL = 'pointer-events-none absolute top-2 rounded-pill bg-surface/90 px-2 py-0.5 text-caption text-ink';

const clamp = (value: number) => Math.min(100, Math.max(0, value));

type CompareSliderProps = {
  beforeUrl: string;
  afterUrl: string;
  beforeAlt: string;
  afterAlt: string;
  className?: string;
};

/**
 * Two versions of the same picture stacked, with a draggable divider: "Before" shows left of it,
 * "After" right of it. The divider is a slider (arrow keys ±5, Home/End); dragging anywhere on the
 * picture moves it. Both images use object-contain in the same box, so they line up uncropped.
 */
export function CompareSlider({ beforeUrl, afterUrl, beforeAlt, afterAlt, className }: CompareSliderProps) {
  const [position, setPosition] = useState(50);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function moveTo(clientX: number) {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPosition(Math.round(clamp(((clientX - rect.left) / rect.width) * 100)));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  }

  function onKeyDown(event: KeyboardEvent) {
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? position - STEP
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? position + STEP
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 100
              : null;
    if (next === null) return;
    event.preventDefault();
    setPosition(clamp(next));
  }

  return (
    <div
      ref={frame}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => dragging.current && moveTo(event.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      // Horizontal drags move the divider; vertical ones still scroll the page on phones.
      className={cn('relative grid w-full cursor-ew-resize touch-pan-y select-none rounded-md bg-surface-2', className)}
    >
      <Image
        src={afterUrl}
        unoptimized={skipOptimizer(afterUrl)}
        alt={afterAlt}
        width={UNKNOWN_SIZE}
        height={UNKNOWN_SIZE}
        sizes={SIZES}
        draggable={false}
        className={IMAGE}
      />
      <Image
        src={beforeUrl}
        unoptimized={skipOptimizer(beforeUrl)}
        alt={beforeAlt}
        width={UNKNOWN_SIZE}
        height={UNKNOWN_SIZE}
        sizes={SIZES}
        draggable={false}
        className={IMAGE}
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />
      <span aria-hidden className={cn(LABEL, 'left-2')}>
        Before
      </span>
      <span aria-hidden className={cn(LABEL, 'right-2')}>
        After
      </span>

      <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-surface shadow-card" style={{ left: `${position}%` }} />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Before and after divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={position}
        aria-valuetext={`${position}% before, ${100 - position}% after`}
        onKeyDown={onKeyDown}
        className="absolute top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill border border-line bg-surface text-ink shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        style={{ left: `${position}%` }}
      >
        <ChevronsLeftRight aria-hidden className="size-5" />
      </div>
    </div>
  );
}
