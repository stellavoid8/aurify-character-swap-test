'use client';

import { CheckCircle2, ImageOff, X, XCircle } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { ERRORS } from '@/lib/errors';
import { skipOptimizer } from '@/lib/image-src';
import type { SlotState } from '@/stores/swap-flow';

type PhotoThumbProps = {
  slot: SlotState;
  /** 1-based position, used in labels. */
  index: number;
  isReference: boolean;
  onRemove: () => void;
  onRetry?: () => void;
};

/** Accessible description of one photo's state, also used by the step's live region. */
export function describePhoto(slot: SlotState, index: number): string {
  if (slot.status === 'ok') return `Photo ${index}: ready`;
  if (slot.status === 'uploading' || slot.status === 'checking') return `Photo ${index}: checking`;
  const message = slot.errorCode ? ERRORS[slot.errorCode].message : '';
  return `Photo ${index}: can't be used: ${message}`;
}

/** While the server check runs, the live check (if it ran) colours the ring. */
function ringClass(slot: SlotState): string {
  if (slot.status === 'ok') return 'ring-success';
  if (slot.status === 'rejected' || slot.status === 'error') return 'ring-danger';
  if (slot.liveCheck === 'ok') return 'ring-success';
  if (slot.liveCheck === 'warn') return 'ring-warning';
  return 'ring-line';
}

export function PhotoThumb({ slot, index, isReference, onRemove, onRetry }: PhotoThumbProps) {
  const [previewBroken, setPreviewBroken] = useState(false);
  const pending = slot.status === 'uploading' || slot.status === 'checking';
  const failed = slot.status === 'rejected' || slot.status === 'error';
  const label = describePhoto(slot, index);
  // The server's JPEG once it exists: the local preview can't render HEIC outside Safari.
  const src = slot.upload?.url ?? slot.previewUrl;
  const showImage = !previewBroken || slot.upload?.url;

  return (
    <div className="flex flex-col gap-2">
      <div className={cn('relative aspect-square rounded-md bg-surface-2 ring-2', ringClass(slot))}>
        {showImage ? (
          <Image
            src={src}
            alt={label}
            fill
            sizes="(min-width: 768px) 240px, 50vw"
            unoptimized={skipOptimizer(src)}
            onError={() => setPreviewBroken(true)}
            className="rounded-md object-cover"
          />
        ) : (
          <div role="img" aria-label={label} className="flex size-full items-center justify-center text-ink-muted">
            <ImageOff aria-hidden className="size-6" />
          </div>
        )}

        {isReference && (
          <Badge tone="accent" className="absolute bottom-2 left-2">
            Main photo
          </Badge>
        )}

        <span aria-hidden className="absolute right-2 bottom-2">
          {pending && (
            <span className="flex size-7 items-center justify-center rounded-pill bg-surface shadow-card">
              <Spinner size="sm" className="text-accent" />
            </span>
          )}
          {slot.status === 'ok' && (
            <span className="flex size-7 items-center justify-center rounded-pill bg-success text-accent-ink">
              <CheckCircle2 className="size-5" />
            </span>
          )}
          {failed && (
            <span className="flex size-7 items-center justify-center rounded-pill bg-danger text-accent-ink">
              <XCircle className="size-5" />
            </span>
          )}
        </span>

        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove photo ${index}`}
          className="group absolute -top-2 -right-2 flex size-11 items-center justify-center rounded-pill focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="flex size-7 items-center justify-center rounded-pill border border-line bg-surface text-ink shadow-card group-hover:bg-surface-2">
            <X aria-hidden className="size-4" />
          </span>
        </button>
      </div>

      {failed && slot.errorCode && (
        <div className="flex flex-col items-start gap-1 text-caption text-danger">
          <p>{ERRORS[slot.errorCode].message}</p>
          <p>{ERRORS[slot.errorCode].nextStep}</p>
          {slot.status === 'error' && onRetry && (
            <Button variant="ghost" onClick={onRetry} className="-ml-3">
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
