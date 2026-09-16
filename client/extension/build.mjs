/**
 * Bundles the extension into dist/, ready to "load unpacked".
 *
 * Two entry points, because they run in different worlds: content.js beside the
 * <video>, sw.js beside the socket. MV3 bans remote code, so both are fully
 * inlined -- the same constraint the userscript build works under.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Firefox: the same two scripts under a different manifest, and it has to be
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
for (const f of ['content.js', 'sw.js']) copyFileSync(join(outdir, f), join(ffdir, f));
const base = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const firefox = {
  manifest_version: 2,
  name: base.name,
  version: base.version,
  description: base.description,
  permissions: base.permissions,
  background: { scripts: ['sw.js'], persistent: false },
  content_scripts: base.content_scripts,
  browser_specific_settings: {
    gecko: { id: 'videosync@videosync.invalid', strict_min_version: '128.0' },
  },
};
writeFileSync(join(ffdir, 'manifest.json'), JSON.stringify(firefox, null, 2) + '\n');
console.log(`built ${ffdir}: same scripts, Firefox MV2 manifest`);
