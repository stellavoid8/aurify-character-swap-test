'use client';

import { Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';

type ShareButtonProps = {
  /** Same-origin download URL, so the file can be fetched without CORS. */
  downloadUrl: string;
  /** Public image (or video) URL, copied when files can't be shared. */
  imageUrl: string;
  filename: string;
  /** The shared file's type. */
  contentType?: 'image/jpeg' | 'video/mp4';
};

const isNamed = (err: unknown, name: string) => err instanceof DOMException && err.name === name;

/**
 * Native share sheet with the picture as a file; otherwise copies the image link.
 * The file is fetched ahead of the tap: iOS drops the tap's permission to share across a slow await.
 */
export function ShareButton({ downloadUrl, imageUrl, filename, contentType = 'image/jpeg' }: ShareButtonProps) {
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    setFile(null);
    if (typeof navigator.canShare !== 'function') return;
    const controller = new AbortController();
    fetch(downloadUrl, { signal: controller.signal })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((blob) => setFile(new File([blob], filename, { type: contentType })))
      .catch(() => {});
    return () => controller.abort();
  }, [downloadUrl, filename, contentType]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(imageUrl);
      toast.success('Link copied');
    } catch {
      toast.error("We couldn't share this picture. Use Download instead.");
    }
  }

  async function share() {
    if (file && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My Character Swap' });
        return;
      } catch (err) {
        if (isNamed(err, 'AbortError')) return;
        // NotAllowedError and friends: fall through to the link.
      }
    }
    await copyLink();
  }

  return (
    <Button variant="secondary" size="lg" onClick={share}>
      <Share2 aria-hidden className="size-4" />
      Share
    </Button>
  );
}
