import { cookies } from 'next/headers';
import { z } from 'zod';
import { env } from './env';
import { AppError } from './errors';

/**
 * Access-code session: an HMAC-SHA256 signed cookie `base64url(payload).base64url(signature)`.
 * Signing and verifying use only Web Crypto so `middleware.ts` (Edge) can import this module.
 */

export const SESSION_COOKIE = 'cs_session';
export const SESSION_TTL_DAYS = 14;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/** `exp` is a Unix time in seconds. */
const payloadSchema = z.object({ sid: z.uuid(), exp: z.number().int().positive() });
export type SessionPayload = z.infer<typeof payloadSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET;
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

export function newSessionPayload(sid: string = crypto.randomUUID()): SessionPayload {
  return { sid, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payloadSchema.parse(payload))));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Returns the payload when the signature is valid and `exp` is in the future, otherwise null. */
export async function verifySession(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const signatureBytes = fromBase64Url(signature);
  const bodyBytes = fromBase64Url(body);
  if (!signatureBytes || !bodyBytes) return null;

  // subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(), signatureBytes, encoder.encode(body));
  if (!valid) return null;

  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(bodyBytes));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  if (parsed.data.exp <= Math.floor(Date.now() / 1000)) return null;
  return parsed.data;
}

/** The current request's session, or null. Server Components, Server Actions and Route Handlers only. */
export async function getSession(): Promise<{ sid: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = await verifySession(token);
  return payload ? { sid: payload.sid } : null;
}

/** Throws `AppError('ACCESS_DENIED')` when there is no valid session. */
export async function requireSession(): Promise<{ sid: string }> {
  const session = await getSession();
  if (!session) throw new AppError('ACCESS_DENIED');
  return session;
}

/** Same-origin path to send the user to after /gate. Anything else (`//evil.com`, `/\evil.com`, URLs) becomes `/`. */
export function safeNextPath(next: string | undefined | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
