import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { normalizeImage, sniffImageType } from '@/lib/images';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe('sniffImageType', () => {
  it('identifies fixtures by their bytes', () => {
    expect(sniffImageType(fixture('exif-orientation-6.jpg'))).toBe('jpeg');
    expect(sniffImageType(fixture('small.png'))).toBe('png');
    expect(sniffImageType(fixture('sample.heic'))).toBe('heic');
    expect(sniffImageType(fixture('document.pdf'))).toBe('pdf');
    expect(sniffImageType(Buffer.from('hello world, not an image'))).toBeNull();
  });

  it('tells AVIF apart from HEIC under the generic mif1 brand', () => {
    const ftyp = (major: string, ...compat: string[]) => {
      const body = Buffer.from(`ftyp${major}\0\0\0\0${compat.join('')}`, 'latin1');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(body.length + 4);
      return Buffer.concat([size, body, Buffer.alloc(16)]);
    };
    expect(sniffImageType(ftyp('mif1', 'mif1', 'heic'))).toBe('heic');
    expect(sniffImageType(ftyp('mif1', 'mif1', 'avif'))).toBe('avif');
    expect(sniffImageType(ftyp('avif', 'mif1'))).toBe('avif');
    expect(sniffImageType(ftyp('heix', 'mif1'))).toBe('heic');
  });
});

describe('normalizeImage', () => {
  it('applies EXIF orientation 6 and strips EXIF', async () => {
    const input = fixture('exif-orientation-6.jpg');
    expect(await sharp(input).metadata()).toMatchObject({ width: 64, height: 32, orientation: 6 });

    const { jpeg, width, height } = await normalizeImage(input);
    expect({ width, height }).toEqual({ width: 32, height: 64 });
    const meta = await sharp(jpeg).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 32, height: 64 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('converts HEIC to JPEG', async () => {
    const { jpeg, width, height } = await normalizeImage(fixture('sample.heic'));
    expect({ width, height }).toEqual({ width: 640, height: 480 });
    expect(sniffImageType(jpeg)).toBe('jpeg');
  });

  it('shrinks a 4000×3000 PNG to fit 1536 px', async () => {
    const png = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#808080' } })
      .png()
      .toBuffer();
    const { jpeg, width, height } = await normalizeImage(png);
    expect({ width, height }).toEqual({ width: 1536, height: 1152 });
    expect(sniffImageType(jpeg)).toBe('jpeg');
  });

  it('never enlarges small images', async () => {
    expect(await normalizeImage(fixture('small.png'))).toMatchObject({ width: 40, height: 30 });
  });

  it('rejects a PDF as UNSUPPORTED_FILE_TYPE', async () => {
    await expect(normalizeImage(fixture('document.pdf'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('rejects unknown bytes and truncated photos as IMAGE_DECODE_FAILED', async () => {
    await expect(normalizeImage(Buffer.from('definitely not a photo at all'))).rejects.toMatchObject({
      code: 'IMAGE_DECODE_FAILED',
    });
    const jpeg = fixture('exif-orientation-6.jpg');
    await expect(normalizeImage(jpeg.subarray(0, jpeg.length / 2))).rejects.toMatchObject({
      code: 'IMAGE_DECODE_FAILED',
    });
    const heic = fixture('sample.heic');
    await expect(normalizeImage(heic.subarray(0, 200))).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
  });
});
