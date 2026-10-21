// Side-effect module: loads .env / .env.local like `next dev` does, for tools that run outside Next
// (drizzle-kit, tsx scripts). Import it before anything that imports lib/env.
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());
