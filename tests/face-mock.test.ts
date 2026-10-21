import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cosine } from '@/lib/face/arcface';
import { mockAnalyzeImage, mockEmbedFace, outcomeForColor } from '@/lib/face/mock';
import { checkUserFaces } from '@/lib/face/quality';

const fixture = (name: string) => readFile(`tests/fixtures/${name}`);

describe('mock face engine', () => {
  it('maps mean colour to an outcome', () => {
    expect(outcomeForColor(220, 40, 40)).toBe('none');
    expect(outcomeForColor(40, 60, 220)).toBe('two');
    expect(outcomeForColor(150, 150, 150)).toBe('one');
    expect(outcomeForColor(40, 220, 40)).toBe('one');
  });

  it('red fixture → no face', async () => {
    const result = await mockAnalyzeImage(await fixture('face-none-red.jpg'));
    expect(result).toMatchObject({ faces: [], width: 640, height: 480 });
    expect(checkUserFaces(result.faces, result.width, result.height)).toEqual({ ok: false, code: 'NO_FACE' });
  });

  it('blue fixture → two faces', async () => {
    const { faces, width, height } = await mockAnalyzeImage(await fixture('face-two-blue.jpg'));
    expect(faces).toHaveLength(2);
    expect(checkUserFaces(faces, width, height)).toEqual({ ok: false, code: 'MULTIPLE_FACES' });
  });

  it('grey fixture → one centred face covering 20% of the image', async () => {
    const { faces, width, height } = await mockAnalyzeImage(await fixture('face-one-grey.jpg'));
    expect(faces).toHaveLength(1);
    const [x, y, w, h] = faces[0].box;
    expect((w * h) / (width * height)).toBeCloseTo(0.2, 6);
    expect(x + w / 2).toBeCloseTo(width / 2, 6);
    expect(y + h / 2).toBeCloseTo(height / 2, 6);
    expect(faces[0].landmarks).toHaveLength(5);
    expect(checkUserFaces(faces, width, height).ok).toBe(true);
  });

  it('embeddings are deterministic, unit length and differ between images', async () => {
    const grey = await fixture('face-one-grey.jpg');
    const { faces } = await mockAnalyzeImage(grey);
    const a = await mockEmbedFace(grey, faces[0]);
    const b = await mockEmbedFace(grey, faces[0]);
    expect(a).toHaveLength(512);
    expect(a).toEqual(b);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);

    const gradient = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#808080' } })
      .composite([{ input: { create: { width: 320, height: 480, channels: 3, background: '#303030' } }, left: 0, top: 0 }])
      .jpeg()
      .toBuffer();
    const other = await mockEmbedFace(gradient, (await mockAnalyzeImage(gradient)).faces[0]);
    expect(Math.abs(cosine(a, other))).toBeLessThan(0.3);
  });
});
