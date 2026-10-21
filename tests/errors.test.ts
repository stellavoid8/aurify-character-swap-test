import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, ERRORS, NOTICES, formatNotice, toActionError, toResponse } from '@/lib/errors';
import type { ErrorCode } from '@/lib/types';

const EXPECTED_CODES = [
  'ACCESS_DENIED',
  'INVALID_ACCESS_CODE',
  'TOO_MANY_ATTEMPTS',
  'RATE_LIMITED_SESSION',
  'RATE_LIMITED_GLOBAL',
  'VALIDATION_FAILED',
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'IMAGE_DECODE_FAILED',
  'UPLOAD_FAILED',
  'NO_FACE',
  'MULTIPLE_FACES',
  'FACE_TOO_SMALL',
  'TOO_MANY_PHOTOS',
  'UPLOAD_NOT_FOUND',
  'JOB_NOT_FOUND',
  'INVALID_STATE',
  'ANALYSIS_FAILED',
  'CONTENT_BLOCKED',
  'GENERATION_FAILED',
  'JOB_TIMED_OUT',
  'REFINEMENT_FAILED',
  'WEBHOOK_UNAUTHORIZED',
  'CRON_UNAUTHORIZED',
  'INTERNAL_ERROR',
];

const JARGON = /seed|inference|webhook|arcface/i;

const codes = Object.keys(ERRORS) as ErrorCode[];

describe('ERRORS catalogue', () => {
  it('contains exactly the agreed codes', () => {
    expect([...codes].sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it.each(codes)('%s has an HTTP status, message and next step', (code) => {
    const { status, message, nextStep } = ERRORS[code];
    expect(Number.isInteger(status) && status >= 400 && status <= 599).toBe(true);
    expect(message.trim()).not.toBe('');
    expect(nextStep.trim()).not.toBe('');
  });

  it.each(codes)('%s copy uses plain words', (code) => {
    const { message, nextStep } = ERRORS[code];
    expect(message).not.toMatch(JARGON);
    expect(nextStep).not.toMatch(JARGON);
  });

  it.each(Object.keys(NOTICES) as (keyof typeof NOTICES)[])('notice %s uses plain words', (code) => {
    expect(NOTICES[code].message).not.toMatch(JARGON);
  });
});

describe('formatNotice', () => {
  it('fills placeholders', () => {
    expect(formatNotice('TEMPLATE_MULTIPLE_PEOPLE', { count: 3, subjectLabel: 'the person on the left' })).toBe(
      "Your template has 3 people. We'll swap the person on the left.",
    );
  });
});

describe('error mapping', () => {
  it('keeps AppError codes but always shows catalogue copy', () => {
    const err = new AppError('NO_FACE', { detail: 'scrfd score 0.12' });
    expect(err.message).toBe('scrfd score 0.12');
    expect(toActionError(err)).toEqual({
      ok: false,
      error: { code: 'NO_FACE', message: ERRORS.NO_FACE.message },
    });
  });

  it('maps Zod errors to VALIDATION_FAILED', () => {
    const result = z.object({ id: z.uuid() }).safeParse({ id: 'nope' });
    expect(toActionError(result.error).error.code).toBe('VALIDATION_FAILED');
  });

  it('hides unknown errors behind INTERNAL_ERROR', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toActionError(new Error('db exploded')).error).toEqual({
      code: 'INTERNAL_ERROR',
      message: ERRORS.INTERNAL_ERROR.message,
    });
    log.mockRestore();
  });

  it('builds a JSON response with the catalogue status', async () => {
    const res = toResponse(new AppError('JOB_NOT_FOUND'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'JOB_NOT_FOUND', message: ERRORS.JOB_NOT_FOUND.message } });
  });
});
