'use client';

import { ImageOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { AppError, ERRORS, formatNotice } from '@/lib/errors';
import { MAX_VIDEO_SECONDS } from '@/lib/limits';
import type { ErrorCode } from '@/lib/types';
import { checkVideoDuration, isVideoFile, preResize, uploadFile, validateFile } from '@/lib/upload-client';
import { normalizeUpload } from '@/server/uploads/actions';
import { useSwapFlow, type SlotState } from '@/stores/swap-flow';
import { Dropzone, FILE_ACCEPT, VIDEO_FILE_ACCEPT } from './Dropzone';

/** Codes that mean "this file won't work", as opposed to a transient failure worth retrying. */
const REJECT_CODES: ErrorCode[] = [
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'IMAGE_DECODE_FAILED',
  'VIDEO_TOO_LONG',
  'VIDEO_TOO_LARGE',
  'VIDEO_DECODE_FAILED',
  'VIDEO_MULTIPLE_PEOPLE',
  'VIDEO_UNAVAILABLE',
];

const STATUS_TEXT: Record<'image' | 'video', Record<SlotState['status'], string>> = {
  image: {
    uploading: 'Uploading photo…',
    checking: 'Checking photo…',
    ok: 'Photo ready.',
    rejected: "This photo can't be used.",
    error: "The photo didn't upload.",
  },
  video: {
    uploading: 'Uploading clip…',
    checking: 'Preparing your clip…',
    ok: 'Clip ready.',
    rejected: "This clip can't be used.",
    error: "The clip didn't upload.",
  },
};

/** 4_200 → "0:04" */
function clipLength(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function ErrorNotice({ code, onRetry }: { code: ErrorCode; onRetry?: () => void }) {
  const { message, nextStep } = ERRORS[code];
  return (
    <Notice tone="danger" title={message}>
      <div className="flex flex-col items-start gap-3">
        <p>{nextStep}</p>
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </Notice>
  );
}

/** Step 1. With `videoEnabled`, the template can also be a clip of up to MAX_VIDEO_SECONDS. */
export function TemplateStep({ sid, videoEnabled, onNext }: { sid: string; videoEnabled: boolean; onNext: () => void }) {
  const template = useSwapFlow((s) => s.template);
  const setTemplate = useSwapFlow((s) => s.setTemplate);
  const updateSlot = useSwapFlow((s) => s.updateSlot);

  const [pickError, setPickError] = useState<ErrorCode | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);
  /** The file behind the current slot, kept so "Try again" can re-upload it. */
  const fileRef = useRef<File | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  const accept = videoEnabled ? `${FILE_ACCEPT},${VIDEO_FILE_ACCEPT}` : FILE_ACCEPT;

  async function run(localId: string, file: File) {
    const media = isVideoFile(file) ? 'video' : 'image';
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
    const result = await normalizeUpload({ kind: 'template', media, rawUrl }).catch(() => null);
    if (!result) {
      updateSlot(localId, { status: 'error', errorCode: 'UPLOAD_FAILED' });
    } else if (!result.ok) {
      const { code } = result.error;
      updateSlot(localId, { status: REJECT_CODES.includes(code) ? 'rejected' : 'error', errorCode: code });
    } else {
      updateSlot(localId, { status: 'ok', uploadId: result.data.id, upload: result.data });
    }
  }

  async function pick(original: File) {
    const video = videoEnabled && isVideoFile(original);
    const code = validateFile(original, { allowVideo: videoEnabled }) ?? (video ? await checkVideoDuration(original) : null);
    setPickError(code);
    if (code) return;

    // Clips go up as they are; the server re-encodes them.
    const file = video ? original : await preResize(original);
    const localId = crypto.randomUUID();
    fileRef.current = file;
    setPreviewBroken(false);
    setTemplate({ localId, previewUrl: URL.createObjectURL(file), mediaType: video ? 'video' : 'image', status: 'uploading', progress: 0 });
    await run(localId, file);
  }

  const retry = () => {
    if (template && fileRef.current) void run(template.localId, fileRef.current);
  };

  const upload = template?.upload;
  const isClip = template?.mediaType === 'video';
  const media = isClip ? 'video' : 'image';
  // The server's JPEG once it exists: the local preview can't render HEIC outside Safari.
  const previewSrc = upload?.url ?? template?.previewUrl;
  // The server's re-encoded MP4 once it exists: the local preview can't play every codec (HEVC .mov in Chrome).
  const clipSrc = upload?.videoUrl ?? template?.previewUrl;

  return (
    <section aria-labelledby="template-heading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 id="template-heading" className="font-display text-title">
          {videoEnabled ? 'Pick a photo or clip to step into' : 'Pick a photo to step into'}
        </h1>
        <p className="text-body text-ink-muted">
          {videoEnabled
            ? `Any photo, or a clip of up to ${MAX_VIDEO_SECONDS} seconds, of someone doing something: jumping, laughing, playing sport.`
            : 'Any photo of someone doing something: jumping, laughing, playing sport.'}
        </p>
      </div>

      <p aria-live="polite" className="sr-only">
        {template ? STATUS_TEXT[media][template.status] : ''}
      </p>

      {pickError && <ErrorNotice code={pickError} />}

      {!template ? (
        <Dropzone
          onFiles={([file]) => void pick(file)}
          accept={accept}
          {...(videoEnabled && {
            title: 'Choose a photo or clip',
            hint: `or drag it here · photos up to 25 MB · clips up to ${MAX_VIDEO_SECONDS} s`,
          })}
        />
      ) : (
        <div className="flex flex-col gap-6 md:grid md:grid-cols-5 md:items-start">
          <div className="flex justify-center rounded-lg border border-line bg-surface/50 p-2 backdrop-blur-md md:col-span-3">
            {isClip && !(previewBroken && !upload?.videoUrl) ? (
              <div className="flex flex-col items-center gap-2">
                <video
                  key={clipSrc}
                  src={clipSrc}
                  poster={upload?.url ?? undefined}
                  aria-label="Your template clip"
                  muted
                  loop
                  autoPlay
                  playsInline
                  controls
                  onError={() => setPreviewBroken(true)}
                  className="block max-h-[45dvh] w-auto max-w-full rounded-md bg-surface-2 object-contain md:max-h-[calc(100dvh-20rem)]"
                />
                {upload?.durationMs != null && (
                  <span className="text-caption text-ink-muted tabular-nums">Clip length {clipLength(upload.durationMs)}</span>
                )}
              </div>
            ) : previewBroken && !upload?.url ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-2 text-small text-ink-muted">
                <ImageOff aria-hidden className="size-6" />
                {isClip ? 'The preview appears once the clip is ready.' : 'The preview appears once the photo is checked.'}
              </div>
            ) : (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element -- blob/object URLs of unknown size */}
                <img
                  src={previewSrc}
                  alt="Your template photo"
                  onError={() => setPreviewBroken(true)}
                  // Shorter on phones so "Next: your photos" stays above the fold.
                  className="block max-h-[45dvh] w-auto max-w-full rounded-md object-contain md:max-h-[calc(100dvh-20rem)]"
                />
                {upload && upload.faceCount > 1 && upload.subjectBox && (
                  <span
                    aria-hidden
                    // The light inner border keeps the marker visible on dark or blue photos.
                    className="absolute rounded-sm border-2 border-accent-ink outline-2 outline-accent"
                    style={{
                      left: `${upload.subjectBox[0] * 100}%`,
                      top: `${upload.subjectBox[1] * 100}%`,
                      width: `${upload.subjectBox[2] * 100}%`,
                      height: `${upload.subjectBox[3] * 100}%`,
                    }}
                  />
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 md:col-span-2">
            {template.status === 'uploading' && (
              <div className="flex flex-col gap-2">
                <p className="text-small text-ink-muted">{isClip ? 'Uploading clip…' : 'Uploading…'}</p>
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(template.progress * 100)}
                  className="h-1 overflow-hidden rounded-pill bg-surface-2"
                >
                  <div className="h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${template.progress * 100}%` }} />
                </div>
              </div>
            )}
            {template.status === 'checking' && (
              <p className="flex items-center gap-2 text-body text-ink-muted">
                <Spinner className="text-accent" />
                {isClip ? 'Preparing your clip… this can take up to a minute.' : 'Checking photo…'}
              </p>
            )}
            {template.status === 'ok' && upload && upload.faceCount === 0 && (
              <Notice tone="warning">{formatNotice('TEMPLATE_NO_FACE_FOUND')}</Notice>
            )}
            {template.status === 'ok' && upload && upload.faceCount > 1 && (
              <Notice tone="info">
                {formatNotice('TEMPLATE_MULTIPLE_PEOPLE', { count: upload.faceCount, subjectLabel: 'the one marked' })}
              </Notice>
            )}
            {(template.status === 'rejected' || template.status === 'error') && template.errorCode && (
              <ErrorNotice code={template.errorCode} onRetry={template.status === 'error' ? retry : undefined} />
            )}

            <div className="flex flex-col gap-3">
              <Button size="lg" disabled={template.status !== 'ok'} onClick={onNext} className="md:w-full">
                Next: your photos
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => replaceInput.current?.click()}
                className="md:w-full"
              >
                {videoEnabled ? 'Choose a different one' : 'Choose a different photo'}
              </Button>
              <input
                ref={replaceInput}
                type="file"
                accept={accept}
                tabIndex={-1}
                aria-hidden
                className="sr-only"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void pick(file);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
