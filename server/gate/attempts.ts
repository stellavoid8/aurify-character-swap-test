import 'server-only';
import { GATE_MAX_FAILS, GATE_WINDOW_MS } from '@/lib/limits';

/**
 * Failed access-code attempts per IP, kept in memory. Each server instance counts on its own,
 * which is enough to make guessing the code slow; it is not a hard global limit.
 */
const failures = new Map<string, { count: number; resetAt: number }>();

function current(ip: string, now: number) {
  const entry = failures.get(ip);
  if (entry && entry.resetAt <= now) {
    failures.delete(ip);
    return undefined;
  }
  return entry;
}

export function isLockedOut(ip: string, now = Date.now()): boolean {
  return (current(ip, now)?.count ?? 0) >= GATE_MAX_FAILS;
}

export function recordFailure(ip: string, now = Date.now()): void {
  const entry = current(ip, now);
  if (entry) {
    entry.count += 1;
  } else {
    failures.set(ip, { count: 1, resetAt: now + GATE_WINDOW_MS });
  }
  // Keep the map from growing without bound on a long-lived instance.
  if (failures.size > 10_000) {
    for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
  }
}

export function clearFailures(ip: string): void {
  failures.delete(ip);
}

/** Tests only. */
export function resetAttempts(): void {
  failures.clear();
}
