import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

/**
 * Each fal submission gets its own callback URL carrying an HMAC of `${candidateId}:${attempt}`.
 * A token is valid for exactly one candidate attempt, so a leaked or replayed URL from a retried
 * attempt cannot complete a different one.
 */

function sign(candidateId: string, attempt: number): Buffer {
  return createHmac('sha256', env.WEBHOOK_SECRET).update(`${candidateId}:${attempt}`).digest();
}

export function webhookUrlFor(candidateId: string, attempt: number): string {
  const params = new URLSearchParams({
    cid: candidateId,
    a: String(attempt),
    t: sign(candidateId, attempt).toString('base64url'),
  });
  return `${env.APP_URL}/api/webhooks/fal?${params}`;
}

export function verifyWebhookToken(candidateId: string, attempt: number, token: string): boolean {
  if (!candidateId || !Number.isInteger(attempt) || attempt < 1 || !token) return false;
  const expected = sign(candidateId, attempt);
  const given = Buffer.from(token, 'base64url');
  // Length check first: timingSafeEqual throws on unequal lengths. The length is not secret.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
