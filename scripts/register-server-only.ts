// Side-effect module: lets tsx scripts import lib modules that start with `import 'server-only'`.
// Next resolves that package itself and it is not installed, so point it at Next's no-op copy
// (same mapping as vitest.config.ts). Import it before any lib module.
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EMPTY = pathToFileURL(path.join(process.cwd(), 'node_modules/next/dist/compiled/server-only/empty.js')).href;

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === 'server-only' ? { url: EMPTY, shortCircuit: true } : nextResolve(specifier, context),
});
