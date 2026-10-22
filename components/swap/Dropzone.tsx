'use client';

import { ImagePlus } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { cn } from '@/lib/cn';

export const FILE_ACCEPT = 'image/*,.heic,.heif';

type DropzoneProps = {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  title?: string;
  hint?: string;
  className?: string;
};

/**
 * Click, tap or drop to pick photos. The whole zone is a <label> around a visually hidden file input,
 * so the input itself is the single tab stop: Space opens the picker natively, Enter is wired up here.
 */
export function Dropzone({
  onFiles,
  multiple = false,
  disabled = false,
  title = 'Choose a photo',
  hint = 'or drag it here · JPG, PNG, WebP, HEIC up to 25 MB',
  className,
}: DropzoneProps) {
  const [dragging, setDragging] = useState(false);

  const deliver = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (!disabled) setDragging(true);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) deliver(event.dataTransfer.files);
  };

  return (
    <label
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'flex min-h-56 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors motion-reduce:transition-none md:min-h-72',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
        dragging ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span aria-hidden className="flex size-14 items-center justify-center rounded-pill bg-accent-soft text-accent">
        <ImagePlus className="size-6" />
      </span>
      <span className="text-heading">{title}</span>
      <span className="text-small text-ink-muted">{hint}</span>
      <input
        type="file"
        accept={FILE_ACCEPT}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        onChange={(event) => {
          deliver(event.currentTarget.files);
          // Lets the same file be picked again after an error.
          event.currentTarget.value = '';
        }}
      />
    </label>
  );
}
