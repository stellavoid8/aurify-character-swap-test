import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import * as schema from './schema';

function createDb() {
  // prepare: false is required by the Supavisor transaction pooler (no prepared statements).
  const client = postgres(env.DATABASE_URL, {
    prepare: false,
    max: env.isProduction ? 3 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}

export type DB = ReturnType<typeof createDb>;

/** `db` or a transaction from `db.transaction(...)`, for helpers that must join the caller's transaction. */
export type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;

// Reuse one pool across dev hot reloads instead of opening a new one per edit.
const globalForDb = globalThis as unknown as { __csDb?: DB };

export const db: DB = globalForDb.__csDb ?? createDb();
if (!env.isProduction) globalForDb.__csDb = db;
