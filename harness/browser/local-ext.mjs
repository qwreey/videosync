// Copies of the built extension that also run on local-media.mjs's pages.
//
// Test-only, and written under .cache/ rather than shipped: the real manifests
// list the providers a user installs this for, and a content script on every
// loopback page is not something to ask a user for.
//
//   node harness/browser/local-ext.mjs
//   -> .cache/ext-local/chromium        (--load-extension=...)
//   -> .cache/firefox-profile/ext-local (inside the Firefox sandbox's reach)
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const LOCAL = 'http://127.0.0.1/*';
for (const [from, to] of [
  ['client/extension/dist', '.cache/ext-local/chromium'],
  ['client/extension/dist-firefox', '.cache/firefox-profile/ext-local'],
]) {
  cpSync(join(root, from), join(root, to), { recursive: true });
  const p = join(root, to, 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  for (const cs of m.content_scripts) if (!cs.matches.includes(LOCAL)) cs.matches.push(LOCAL);
  writeFileSync(p, JSON.stringify(m, null, 2));
  console.log(`${to}: ${m.content_scripts[0].matches.join(' ')}`);
}
