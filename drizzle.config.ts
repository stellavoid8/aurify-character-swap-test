import './scripts/load-env';
import { defineConfig } from 'drizzle-kit';
import { env } from './lib/env';

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations go through the Supabase session pooler; the runtime transaction pooler can't run DDL reliably.
  dbCredentials: { url: env.DIRECT_URL ?? env.DATABASE_URL },
});
