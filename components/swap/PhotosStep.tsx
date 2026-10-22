'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { AppError, ERRORS, isErrorCode } from '@/lib/errors';
import { liveCheck } from '@/lib/face/browser';
import { MAX_USER_PHOTOS } from '@/lib/limits';
import type { ApiResponse, ErrorCode } from '@/lib/types';
import { preResize, uploadFile, validateFile } from '@/lib/upload-client';
import { normalizeUpload } from '@/server/uploads/actions';
import { useSwapFlow, type SlotState } from '@/stores/swap-flow';
import { Dropzone } from './Dropzone';
import { PhotoGuidance } from './PhotoGuidance';
import { describePhoto, PhotoThumb } from './PhotoThumb';

/** Codes that mean "this photo won't work", as opposed to a transient failure worth retrying. */
const REJECT_CODES: ErrorCode[] = [
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'IMAGE_DECODE_FAILED',
  'NO_FACE',
  'MULTIPLE_FACES',
  'FACE_TOO_SMALL',
];

const isPending = (slot: SlotState) => slot.status === 'uploading' || slot.status === 'checking';
const isFailed = (slot: SlotState) => slot.status === 'rejected' || slot.status === 'error';
const isRateLimit = (code: ErrorCode) => code === 'RATE_LIMITED_SESSION' || code === 'RATE_LIMITED_GLOBAL';

/** POST /api/jobs. Resolves to the new job id or an error code; never throws. */
async function startJob(templateUploadId: string, userUploadIds: string[]): Promise<{ jobId: string } | { code: ErrorCode }> {
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateUploadId, userUploadIds }),
    });
    const body = (await res.json()) as ApiResponse<{ jobId: string }>;
    if ('data' in body) return body.data;
    return { code: isErrorCode(body.error?.code) ? body.error.code : 'INTERNAL_ERROR' };
  } catch {
    return { code: 'INTERNAL_ERROR' };
  }
}

/** Runs the in-browser face check; null when the browser can't decode the photo (HEIC outside Safari). */
async function runLiveCheck(file: File): Promise<'ok' | 'warn' | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    return await liveCheck(bitmap);
  } finally {
    bitmap.close();
  }
}

export function PhotosStep({ sid, onBack }: { sid: string; onBack: () => void }) {
  const template = useSwapFlow((s) => s.template);
  const photos = useSwapFlow((s) => s.photos);
  const referenceLocalId = useSwapFlow((s) => s.referenceLocalId);
  const addPhotos = useSwapFlow((s) => s.addPhotos);
  const updateSlot = useSwapFlow((s) => s.updateSlot);
  const removeSlot = useSwapFlow((s) => s.removeSlot);
  const router = useRouter();

  const [overflow, setOverflow] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ErrorCode | null>(null);
  /** The (pre-resized) file behind each slot, kept so "Try again" can re-upload it. */
  const files = useRef(new Map<string, File>());

  async function upload(localId: string, file: File) {
    updateSlot(localId, { status: 'uploading', progress: 0, errorCode: undefined });
    let rawUrl: string;
    try {
      rawUrl = await uploadFile(file, { sid }, (progress) => updateSlot(localId, { progress }));
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'UPLOAD_FAILED';
      updateSlot(localId, { status: REJECT_CODES.includes(code) ? 'rejected' : 'error', errorCode: code });
      return;
    }

    updateSlot(localId, { status: 'checking', progress: 1 });
    const result = await normalizeUpload({ kind: 'user', rawUrl }).catch(() => null);
    if (!result) {
      updateSlot(localId, { status: 'error', errorCode: 'UPLOAD_FAILED' });
    } else if (!result.ok) {
      const { code } = result.error;
      updateSlot(localId, { status: REJECT_CODES.includes(code) ? 'rejected' : 'error', errorCode: code });
    } else {
      updateSlot(localId, { status: 'ok', uploadId: result.data.id, upload: result.data });
    }
  }

  async function process(localId: string, original: File) {
    const file = await preResize(original);
    files.current.set(localId, file);
    // The live check only colours the ring while the upload runs; it never holds the upload up.
    void runLiveCheck(file).then((result) => updateSlot(localId, { liveCheck: result }));
    await upload(localId, file);
  }

  function pick(picked: File[]) {
    const room = MAX_USER_PHOTOS - useSwapFlow.getState().photos.length;
    setOverflow(picked.length > room);
    const originals = new Map<string, File>();
    const slots = picked.slice(0, Math.max(0, room)).map((file): SlotState => {
      const code = validateFile(file);
      const localId = crypto.randomUUID();
      originals.set(localId, file);
      return {
        localId,
        previewUrl: URL.createObjectURL(file),
        status: code ? 'rejected' : 'uploading',
        progress: 0,
        errorCode: code ?? undefined,
      };
    });
    for (const { localId, status } of addPhotos(slots)) {
      if (status === 'uploading') void process(localId, originals.get(localId)!);
    }
  }

  const remove = (localId: string) => {
    files.current.delete(localId);
    setOverflow(false);
    removeSlot(localId);
  };

  const retry = (localId: string) => {
    const file = files.current.get(localId);
    if (file) void upload(localId, file);
  };

  const ready = photos.filter((p) => p.status === 'ok');
  const rateLimited = startError !== null && isRateLimit(startError);
  const canSubmit = ready.length > 0 && !photos.some(isPending) && !!template?.uploadId && !rateLimited;
  const allFailed = photos.length > 0 && photos.every(isFailed);

  // The server picks the main photo itself, from the same quality scores plus the likeness check.
  const submit = async () => {
    if (!template?.uploadId) return;
    setStarting(true);
    setStartError(null);
    const result = await startJob(template.uploadId, ready.map((p) => p.uploadId!));
    if ('jobId' in result) {
      // Stay in the "Starting…" state until the next page takes over.
      router.push(`/jobs/${result.jobId}`);
      return;
    }
    setStartError(result.code);
    setStarting(false);
  };

  const templateSrc = template?.upload?.url ?? template?.previewUrl;

  return (
    <section aria-labelledby="photos-heading" className="flex flex-col gap-6 pb-32 md:pb-0">
      {templateSrc && (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob/object URLs of unknown size */}
          <img src={templateSrc} alt="Your template photo" className="size-14 rounded-md object-cover" />
          <Button variant="ghost" onClick={onBack}>
            Change
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h1 id="photos-heading" className="font-display text-title">
          Add photos of yourself
        </h1>
        <p className="text-body text-ink-muted">
          1 to {MAX_USER_PHOTOS} photos. More photos help us get your likeness right.
        </p>
      </div>

      <PhotoGuidance highlight={allFailed} />

      <p aria-live="polite" className="sr-only">
        {photos.map((p, i) => describePhoto(p, i + 1)).join('. ')}
      </p>

      {overflow && (
        <Notice tone="warning" title={ERRORS.TOO_MANY_PHOTOS.message}>
          {ERRORS.TOO_MANY_PHOTOS.nextStep}
        </Notice>
      )}
      {allFailed && (
        <Notice tone="danger" title="None of these photos can be used yet.">
          Check the tips above, then add another photo.
        </Notice>
      )}

      {photos.length < MAX_USER_PHOTOS && (
        <Dropzone
          multiple
          onFiles={pick}
          title={photos.length === 0 ? 'Choose photos of yourself' : 'Add another photo'}
          hint="or drag them here · JPG, PNG, WebP, HEIC up to 25 MB"
          className={photos.length > 0 ? 'min-h-32 md:min-h-40' : undefined}
        />
      )}

      {photos.length > 0 && (
        <ul aria-label="Your photos" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {photos.map((slot, i) => (
            <li key={slot.localId}>
              <PhotoThumb
                slot={slot}
                index={i + 1}
                isReference={slot.localId === referenceLocalId}
                onRemove={() => remove(slot.localId)}
                onRetry={files.current.has(slot.localId) ? () => retry(slot.localId) : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface p-4 md:static md:border-0 md:bg-transparent md:p-0">
        {startError && (
          <Notice
            tone={rateLimited ? 'warning' : 'danger'}
            title={ERRORS[startError].message}
            className="mx-auto mb-3 max-w-5xl md:mb-4"
          >
            {ERRORS[startError].nextStep}
          </Notice>
        )}
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 md:flex-row-reverse md:justify-start md:gap-4">
          <Button size="lg" disabled={!canSubmit} loading={starting} onClick={submit}>
            {starting ? 'Starting…' : 'Make my picture'}
          </Button>
          <p className="text-caption text-ink-muted">Takes about 1–2 minutes</p>
        </div>
      </div>
    </section>
  );
}
