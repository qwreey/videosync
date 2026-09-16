/**
 * Bundles the extension into dist/, ready to "load unpacked".
 *
 * Three entry points, because they run in different places: content.js beside
 * the <video>, sw.js beside the socket, options.js in the extension's own
 * options page. MV3 bans remote code, so all are fully inlined -- the same
 * constraint the userscript build works under. Provider descriptors are data
 * compiled in (client/core/scripts/providers.mjs), and the manifest's page
 * list is generated from them.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchPatterns, writeGenerated } from '../core/scripts/providers.mjs';
import { chromeManifest, firefoxManifest } from './manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, 'dist');
mkdirSync(outdir, { recursive: true });

// Before bundling: the bundle imports the generated file.
const builtins = writeGenerated();
const patterns = matchPatterns(builtins);

const result = await build({
  entryPoints: [join(here, 'src', 'content.ts'), join(here, 'src', 'sw.ts'), join(here, 'src', 'options.ts')],
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

const base = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(chromeManifest(base, patterns), null, 2) + '\n');
copyFileSync(join(here, 'src', 'options.html'), join(outdir, 'options.html'));
const FILES = ['content.js', 'sw.js', 'options.js', 'options.html'];
const sizes = [...FILES, 'manifest.json']
  .map((f) => `${f} ${(readFileSync(join(outdir, f)).length / 1024).toFixed(1)} kB`);
console.log(`built ${outdir}: ${sizes.join(', ')}`);
console.log(`pages: ${patterns.join(' ')} (from ${builtins.map((b) => b.file).join(', ')})`);

// Firefox: the same scripts under a different manifest, and it has to be
// Manifest V2. Measured (docs/BROWSER-FINDINGS.md §19): an MV3 extension page in
// Firefox always carries `upgrade-insecure-requests` -- it is in the base policy
// Firefox adds to every MV3 extension, and a manifest `content_security_policy`
// does not remove it -- so the relay's ws://127.0.0.1 left as a TLS ClientHello
// (close 1015), for `localhost` too. A plaintext server on your own machine is
// the reason this shim exists. MV2's base policy has no such directive, and
// Firefox has committed to keeping MV2. `background.scripts` is also the only
// background Firefox has ever run; it never shipped `service_worker`.
const ffdir = join(here, 'dist-firefox');
mkdirSync(ffdir, { recursive: true });
for (const f of FILES) copyFileSync(join(outdir, f), join(ffdir, f));
writeFileSync(join(ffdir, 'manifest.json'), JSON.stringify(firefoxManifest(base, patterns), null, 2) + '\n');
console.log(`built ${ffdir}: same scripts, Firefox MV2 manifest`);
