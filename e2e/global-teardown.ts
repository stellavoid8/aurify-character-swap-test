import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { closeDb, deleteSessions } from './helpers/db';
import { PHOTOS, SESSIONS_FILE, fixture } from './helpers/flow';

/**
 * Removes what the run left behind: the sessions' rows (the database may be a shared dev project,
 * and mock rows would skew its daily caps), their local uploads, and the oversized photo.
 */
export default async function globalTeardown(): Promise<void> {
  rmSync(fixture(PHOTOS.big), { force: true });

  const sids = existsSync(SESSIONS_FILE)
    ? [...new Set(readFileSync(SESSIONS_FILE, 'utf8').split('\n').filter((line) => /^[0-9a-f-]{36}$/.test(line)))]
    : [];
  try {
    await deleteSessions(sids);
  } finally {
    await closeDb();
  }
  for (const sid of sids) {
    rmSync(path.join(process.cwd(), 'public', 'uploads', 'sessions', sid), { recursive: true, force: true });
  }
}
