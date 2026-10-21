'use server';

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { env } from '@/lib/env';
import { AppError, toActionError } from '@/lib/errors';
import { GATE_FAIL_DELAY_MS } from '@/lib/limits';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionPayload,
  safeNextPath,
  signSession,
  verifySession,
} from '@/lib/session';
import type { ActionResult } from '@/lib/types';
import { clearFailures, isLockedOut, recordFailure } from './attempts';

const gateSchema = z.object({
  code: z.string().trim().min(1).max(64),
  next: z.string().startsWith('/').default('/'),
});
// Parsed field by field: a bad `next` must not turn a correct code into a failure.
const { code: codeSchema, next: nextSchema } = gateSchema.shape;

export type GateState = ActionResult<null> | null;

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Checks the shared access code, sets the `cs_session` cookie and redirects to `next`. Used with `useActionState`. */
export async function submitGate(_prevState: GateState, formData: FormData): Promise<GateState> {
  // An empty or oversized code is just a wrong code; a malformed `next` falls back to `/`.
  const code = codeSchema.safeParse(formData.get('code')).data ?? null;
  const next = safeNextPath(nextSchema.safeParse(formData.get('next') || undefined).data);

  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isLockedOut(ip)) return toActionError(new AppError('TOO_MANY_ATTEMPTS'));

  if (code === null || !timingSafeEqual(digest(code), digest(env.ACCESS_CODE))) {
    recordFailure(ip);
    await new Promise((resolve) => setTimeout(resolve, GATE_FAIL_DELAY_MS));
    return toActionError(new AppError('INVALID_ACCESS_CODE'));
  }

  clearFailures(ip);
  const cookieStore = await cookies();
  const existing = await verifySession(cookieStore.get(SESSION_COOKIE)?.value);
  cookieStore.set(SESSION_COOKIE, await signSession(newSessionPayload(existing?.sid)), {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(next);
}
