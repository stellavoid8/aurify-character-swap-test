import { describe, expect, it } from 'vitest';
import {
  buildAnimateInput,
  buildNormalizeInput,
  normalizedSize,
  parseFrameOutput,
  parseVideoMetadata,
  parseVideoOutput,
} from '@/lib/fal/models';
import { falVideoCostMicros } from '@/lib/fal/pricing';
import { MAX_VIDEO_SECONDS, VIDEO_TARGET_FPS } from '@/lib/limits';

describe('parseVideoMetadata', () => {
  it('reads duration, fps, frame count and size from fal metadata', () => {
    const payload = { media: { duration: 14.5, fps: 59.94, frame_count: 869, resolution: { width: 1080, height: 1920, aspect_ratio: '9:16' } } };
    expect(parseVideoMetadata(payload)).toEqual({ durationMs: 14_500, fps: 59.94, width: 1080, height: 1920, frameCount: 869 });
  });

  it('returns nulls for missing or nonsense fields', () => {
    expect(parseVideoMetadata({ media: { duration: 'long', fps: -1 } })).toEqual({
      durationMs: null,
      fps: null,
      width: null,
      height: null,
      frameCount: null,
    });
    expect(parseVideoMetadata(null).durationMs).toBeNull();
  });
});

describe('normalizedSize', () => {
  it('shrinks the long edge to the limit with even sides', () => {
    expect(normalizedSize(2160, 3840, 1280)).toEqual({ width: 720, height: 1280 });
    expect(normalizedSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it('keeps clips that are already small enough', () => {
    expect(normalizedSize(1280, 720, 1280)).toBeNull();
    expect(normalizedSize(null, 720, 1280)).toBeNull();
  });

  it('keeps the source size when a side would fall under fal’s 512 px minimum', () => {
    expect(normalizedSize(4000, 1000, 1280)).toBeNull();
  });
});

describe('input builders', () => {
  it('normalize passes the size only when there is one', () => {
    expect(buildNormalizeInput({ videoUrl: 'v', fps: 24, size: null })).toEqual({ video_urls: ['v'], target_fps: 24 });
    expect(buildNormalizeInput({ videoUrl: 'v', fps: 24, size: { width: 720, height: 1280 } })).toMatchObject({
      resolution: { width: 720, height: 1280 },
    });
  });

  it('animate keeps the output safety check on', () => {
    expect(buildAnimateInput({ videoUrl: 'v', imageUrl: 'i', seed: 7, resolution: '580p' })).toEqual({
      video_url: 'v',
      image_url: 'i',
      seed: 7,
      resolution: '580p',
      enable_output_safety_checker: true,
    });
  });
});

describe('output parsers', () => {
  it('reads the video and frame URLs', () => {
    expect(parseVideoOutput({ video: { url: 'https://fal.media/v.mp4' }, seed: 1 })).toEqual({ videoUrl: 'https://fal.media/v.mp4' });
    expect(parseVideoOutput({ images: [] })).toEqual({ videoUrl: null });
    expect(parseFrameOutput({ images: [{ url: 'https://fal.media/f.png' }] })).toEqual({ imageUrl: 'https://fal.media/f.png' });
    expect(parseFrameOutput({})).toEqual({ imageUrl: null });
  });
});

describe('falVideoCostMicros', () => {
  it('bills frames ÷ 16 at the resolution price', () => {
    // A 15 s clip at the normalized 24 fps: 360 frames, 22.5 billed seconds.
    expect(falVideoCostMicros(MAX_VIDEO_SECONDS * VIDEO_TARGET_FPS, '580p')).toBe(1_350_000);
    expect(falVideoCostMicros(MAX_VIDEO_SECONDS * VIDEO_TARGET_FPS, '720p')).toBe(1_800_000);
    expect(falVideoCostMicros(0, '480p')).toBe(0);
  });
});
