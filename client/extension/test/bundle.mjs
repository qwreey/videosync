/**
 * Loads an extension source file the way the build does: bundled by esbuild
 * with the `@videosync/core` alias, which Node cannot resolve by itself. Each
 * call is a fresh module instance, so a file with load-time side effects
 * (sw.ts registers listeners) can be loaded once per test against its own
 * fake globals.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function load(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'videosync-ext-test-'));
  try {
    const out = join(dir, 'out.mjs');
    await build({
      entryPoints: [join(here, '..', 'src', entry)],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      outfile: out,
      alias: { '@videosync/core': join(here, '..', '..', 'core', 'src') },
      logLevel: 'silent',
    });
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
