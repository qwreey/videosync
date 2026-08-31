/**
 * Does the extension actually need `host_permissions: ["<all_urls>"]`?
 *
 * The service worker needs it for exactly one thing: `POST /api/rooms` to
 * whatever server the user configures. But videosyncd sends
 * `Access-Control-Allow-Origin: *`, so an ordinary CORS fetch from the worker
 * might already work -- and an extension that asks for every site is a much
 * bigger thing to install than one that does not.
 *
 * Loads the real build twice, once with the permission and once without.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = process.env.PORT || 8899;
const SYNC_PORT = 8788;
const SERVER = `http://127.0.0.1:${SYNC_PORT}`;
const out = { checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const built = join(process.cwd(), '..', '..', 'client', 'extension', 'dist');
if (!existsSync(join(built, 'content.js'))) { console.error('build client/extension first'); process.exit(2); }
const bin = join(process.cwd(), 'dist', 'videosyncd');
const server = spawn(bin, ['-addr', `127.0.0.1:${SYNC_PORT}`], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${SERVER}/healthz`)).ok) break; } catch {}
  await sleep(100);
}

function stage(withHostPerms) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-perm-'));
  cpSync(built, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.content_scripts[0].matches.push('http://127.0.0.1/*', 'http://localhost/*');
  if (!withHostPerms) delete m.host_permissions;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

let port = 9471;
try {
  for (const withPerms of [true, false]) {
    const dir = stage(withPerms);
    const b = await launch({
      port: port++, headful: true,
      extraFlags: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--window-size=700,500'],
    });
    try {
      const tab = await newTab(b.port, `http://127.0.0.1:${MEDIA}/ext-page.html`);
      const s = await new Session(tab.webSocketDebuggerUrl).open();
      s.trackContexts();
      await s.send('Runtime.enable');
      await s.send('Page.enable');
      const loaded = new Promise((res) => s.on('Page.loadEventFired', res));
      await s.send('Page.reload');
      await Promise.race([loaded, sleep(20000)]);
      await s.waitFor('!!window.VideoSync', { timeoutMs: 20000, isolated: true });

      const label = withPerms ? 'with <all_urls>' : 'WITHOUT host_permissions';
      const room = await s.evalIsolated(
        `window.VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')` +
        `.then(r => ({ ok: true, roomId: r.roomId }), e => ({ ok: false, err: String(e && e.message) }))`);
      check(`${label}: the worker can create a room`, room.ok, room.ok ? room.roomId : room.err);
      if (room.ok) {
        const joined = await s.waitFor("window.VideoSync.status().state === 'joined'",
          { timeoutMs: 15000, isolated: true }).then(() => true, () => false);
        check(`${label}: the relayed socket opens`, joined);
      }
      s.close();
    } finally {
      await b.close();
    }
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  server.kill();
}
mkdirSync('results', { recursive: true });
writeFileSync('results/ext-permissions.json', JSON.stringify(out, null, 2));
const bad = out.checks.filter((c) => !c.ok).length;
console.log(`\n${out.checks.length - bad}/${out.checks.length} checks passed`);
console.log('If the no-permission arm passes, the manifest can drop <all_urls>.');
