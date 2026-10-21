import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Vendor SDKs stay behind their adapters: the pipeline only sees lib/ai and lib/fal. */

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'coverage', 'drizzle', 'public', 'models', 'tests']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(ROOT).map((file) => ({ rel: path.relative(ROOT, file), text: readFileSync(file, 'utf8') }));

describe('provider import boundaries', () => {
  it.each([
    ['@anthropic-ai/sdk', 'lib/ai/'],
    ['@fal-ai/client', 'lib/fal/'],
  ])('%s is imported only under %s', (pkg, allowed) => {
    const pattern = new RegExp(`from\\s+['"]${pkg}[/'"]|import\\(\\s*['"]${pkg}[/'"]|require\\(\\s*['"]${pkg}[/'"]`);
    const offenders = files.filter((f) => pattern.test(f.text) && !f.rel.startsWith(allowed)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
