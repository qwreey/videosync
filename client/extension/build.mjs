/**
 * Bundles the extension into dist/, ready to "load unpacked".
 *
 * Two entry points, because they run in different worlds: content.js beside the
 * <video>, sw.js beside the socket. MV3 bans remote code, so both are fully
 * inlined -- the same constraint the userscript build works under.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, 'dist');
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(here, 'src', 'content.ts'), join(here, 'src', 'sw.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'none',
  outdir,
  alias: { '@videosync/core': join(here, '..', 'core', 'src') },
  logLevel: 'info',
});
if (result.errors.length) process.exit(1);

copyFileSync(join(here, 'manifest.json'), join(outdir, 'manifest.json'));
const sizes = ['content.js', 'sw.js', 'manifest.json']
  .map((f) => `${f} ${(readFileSync(join(outdir, f)).length / 1024).toFixed(1)} kB`);
console.log(`built ${outdir}: ${sizes.join(', ')}`);
