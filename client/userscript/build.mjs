/**
 * Bundles the userscript.
 *
 * One IIFE, no imports at runtime: MV3 bans remote code and Tampermonkey has
 * no module loader worth relying on, so everything the script needs is inlined
 * by esbuild. The metadata block is prepended verbatim rather than generated,
 * because it is the part a user reads before trusting the script.
 */
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist', 'videosync.user.js');
mkdirSync(dirname(out), { recursive: true });

const banner = readFileSync(join(here, 'meta.txt'), 'utf8').trimEnd();

const result = await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: banner },
  outfile: out,
  alias: { '@videosync/core': join(here, '..', 'core', 'src') },
  logLevel: 'info',
});
if (result.errors.length) process.exit(1);

const bytes = readFileSync(out).length;
writeFileSync(out, readFileSync(out, 'utf8'));
console.log(`built ${out} (${(bytes / 1024).toFixed(1)} kB)`);
