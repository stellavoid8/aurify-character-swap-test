import 'server-only';
import heicConvert from 'heic-convert';
import sharp from 'sharp';
import { AppError } from './errors';
import { NORMALIZE_LONG_EDGE } from './limits';

/** Formats we accept, plus formats we recognize only to reject them as unsupported. */
export type SniffedType = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'gif' | 'tiff' | 'bmp' | 'pdf';
export const ACCEPTED_TYPES = ['jpeg', 'png', 'webp', 'heic'] as const satisfies readonly SniffedType[];

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
/** Generic HEIF brands: also used by AVIF, so the compatible-brand list decides. */
const HEIF_GENERIC_BRANDS = new Set(['mif1', 'msf1']);

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

/** Identifies the file from its magic bytes; never trusts the name or the declared MIME type. */
export function sniffImageType(buf: Buffer): SniffedType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  if (ascii(buf, 0, 5) === '%PDF-') return 'pdf';
  if (ascii(buf, 0, 4) === 'GIF8') return 'gif';
  if (ascii(buf, 0, 2) === 'BM') return 'bmp';
  if (ascii(buf, 0, 4) === 'II*\0' || ascii(buf, 0, 4) === 'MM\0*') return 'tiff';

  if (ascii(buf, 4, 8) === 'ftyp') {
    const boxSize = Math.min(buf.readUInt32BE(0), buf.length);
    const major = ascii(buf, 8, 12);
    // Compatible brands follow the 4-byte minor version.
    const brands = [major];
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(buf, offset, offset + 4));
    if (HEIC_BRANDS.has(major)) return 'heic';
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    if (HEIF_GENERIC_BRANDS.has(major) || brands.some((brand) => HEIC_BRANDS.has(brand))) return 'heic';
  }
  return null;
}

/**
 * Turns any accepted upload into the pipeline's working image: EXIF orientation applied,
 * long edge ≤ NORMALIZE_LONG_EDGE, sRGB JPEG with all metadata (EXIF, GPS, ICC) stripped.
 * Throws UNSUPPORTED_FILE_TYPE for recognized non-photo formats, IMAGE_DECODE_FAILED for anything unreadable.
 */
export async function normalizeImage(buffer: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const type = sniffImageType(buffer);
  if (type === null) throw new AppError('IMAGE_DECODE_FAILED', { detail: 'unrecognized file signature' });
  if (!(ACCEPTED_TYPES as readonly string[]).includes(type)) {
    throw new AppError('UNSUPPORTED_FILE_TYPE', { detail: `sniffed ${type}` });
  }

  let input = buffer;
  if (type === 'heic') {
    // Prebuilt sharp's libheif has no HEVC decoder, so HEIC goes through libheif-js first.
    try {
      input = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.92 }));
    } catch (err) {
      throw new AppError('IMAGE_DECODE_FAILED', { detail: 'heic-convert failed', cause: err });
    }
  }

  try {
    // Metadata is dropped because withMetadata()/keepExif() is never called; rotate() bakes orientation in first.
    const { data, info } = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize({ width: NORMALIZE_LONG_EDGE, height: NORMALIZE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { jpeg: data, width: info.width, height: info.height };
  } catch (err) {
    throw new AppError('IMAGE_DECODE_FAILED', { detail: `sharp could not decode ${type}`, cause: err });
  }
}
