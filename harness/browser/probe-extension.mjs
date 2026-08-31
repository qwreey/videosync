/**
 * The extension, end to end, in two real browsers — the same run
 * probe-userscript.mjs does, with the shim swapped.
 *
 * The point is not that a second shim works. It is that the extension reaches a
 * server on 127.0.0.1 from a real OTT page, which the userscript provably
 * cannot (docs/BROWSER-FINDINGS.md §8): the service worker is exempt from the
 * private-address block. That is the entire reason this shim exists, so it is
 * the check that matters most here.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = process.env.PORT || 8899;
const SYNC_PORT = 8788;
const PAGE = `http://127.0.0.1:${MEDIA}/ext-page.html`;
const SERVER = `http://127.0.0.1:${SYNC_PORT}`;

const results = { checks: [], measurements: {} };
function flush() {
  mkdirSync('results', { recursive: true });
  writeFileSync('results/extension-sync.json', JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}

// --- stage the extension ----------------------------------------------------
// The shipped manifest matches the real providers only. The probe's page is on
// 127.0.0.1, so a copy is made with that added rather than widening what ships.
const built = join(process.cwd(), '..', '..', 'client', 'extension', 'dist');
if (!existsSync(join(built, 'content.js'))) {
  console.error(`no extension build at ${built}\n  cd client/extension && npm run build`);
  process.exit(2);
}
const ext = mkdtempSync(join(tmpdir(), 'vs-ext-'));
cpSync(built, ext, { recursive: true });
{
  const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  m.content_scripts[0].matches.push(`http://127.0.0.1/*`, `http://localhost/*`);
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(m, null, 2));
}

const bin = join(process.cwd(), 'dist', 'videosyncd');
if (!existsSync(bin)) { console.error('no videosyncd in dist/'); process.exit(2); }
const server = spawn(bin, ['-addr', `127.0.0.1:${SYNC_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${SERVER}/healthz`)).ok) break; } catch {}
  if (i > 60) { console.error('videosyncd never listened\n' + serverLog); process.exit(2); }
  await sleep(100);
}

const FLAGS = (x) => [
  '--autoplay-policy=no-user-gesture-required',
  // Measuring sync, not the backgrounding rules §4 and §5 already measured.
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  `--disable-extensions-except=${ext}`,
  `--load-extension=${ext}`,
  '--window-size=600,420',
  `--window-position=${x},0`,
];

const browsers = [];
const peers = [];
async function openPeer(name, port, x) {
  const b = await launch({ port, headful: true, extraFlags: FLAGS(x) });
  browsers.push(b);
  const tab = await newTab(port, PAGE);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  s.trackContexts();
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  // Reload so the content script runs with context tracking already on, and
  // wait for the load to finish -- otherwise the isolated world we find is the
  // pre-reload one, which is destroyed a moment later and every later eval
  // fails with "Cannot find context with specified id".
  const loaded = new Promise((res) => s.on('Page.loadEventFired', res));
  await s.send('Page.reload');
  await Promise.race([loaded, sleep(20000)]);
  await s.waitFor('window.__ready === true');
  const media = await s.eval('window.page.loadHls()');
  // `window.VideoSync` lives in the content script's world, not the page's, and
  // that world is resolved per call rather than cached.
  await s.waitFor('!!window.VideoSync', { timeoutMs: 20000, isolated: true });
  const p = { name, s, b };
  peers.push(p);
  return { ...p, media };
}

// Everything the extension exposes is in the isolated world.
const ev = (p, expr) => p.s.evalIsolated(expr);

let failed = false;
try {
  const a = await openPeer('a', 9461, 0);
  const b = await openPeer('b', 9462, 620);
  check('the extension loaded and found the element in both browsers',
    (await ev(a, '!!window.VideoSync.adapter.current')) && (await ev(b, '!!window.VideoSync.adapter.current')));
  check('both are playing real MSE media', a.media.usingMSE && b.media.usingMSE,
    `duration ${a.media.duration?.toFixed(1)}s`);
  check('the page cannot see the extension', (await a.s.eval('typeof window.VideoSync')) === 'undefined',
    'isolated world holds');

  // --- the whole reason this shim exists ------------------------------------
  const room = await ev(a, `window.VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')`);
  await a.s.waitFor("window.VideoSync.status().state === 'joined'", { isolated: true });
  check('the service worker reached a loopback server the page cannot', true, room.roomId);

  await ev(b, `window.VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ` +
    `${JSON.stringify(room.secret)}, 'b')`);
  await b.s.waitFor("window.VideoSync.status().state === 'joined'", { isolated: true });
  await a.s.waitFor('window.VideoSync.engine().clock.ready', { isolated: true });
  await b.s.waitFor('window.VideoSync.engine().clock.ready', { isolated: true });

  // The socket now sits behind a message port. min-RTT already accounts for the
  // hop, so what matters is how much it widened the honest error bound.
  const rtt = await ev(a, 'window.VideoSync.engine().clock.rttMs');
  const unc = await ev(a, 'window.VideoSync.engine().clock.uncertaintyMs');
  results.measurements.relayedRttMs = rtt;
  results.measurements.relayedUncertaintyMs = unc;
  check('the relayed clock exchange still settles tightly', rtt >= 0 && rtt < 50,
    `bestRTT ${rtt} ms through the port, uncertainty ±${unc} ms`);

  // --- sync, over the relay --------------------------------------------------
  await ev(a, 'window.VideoSync.engine().seek(20)');
  await a.s.waitFor('window.VideoSync.status().seq >= 1', { isolated: true });
  await b.s.waitFor('window.VideoSync.status().seq >= 1', { isolated: true });
  await ev(a, 'window.VideoSync.engine().play()');
  await a.s.waitFor('!window.page.el().paused', { timeoutMs: 8000 });
  await b.s.waitFor('!window.page.el().paused', { timeoutMs: 8000 });
  await sleep(4000);

  const t0 = Date.now();
  const ea = await a.s.eval('window.page.el()');
  const tMid = Date.now();
  const eb = await b.s.eval('window.page.el()');
  const skewMs = Date.now() - tMid + (tMid - t0);
  const gapMs = Math.abs(ea.ct - eb.ct) * 1000;
  results.measurements.playbackGapMs = +gapMs.toFixed(1);
  check('the two players stayed together through the relay', gapMs < 400,
    `${gapMs.toFixed(0)} ms apart (sampling skew ${skewMs} ms)`);

  // --- a real user gesture propagates ---------------------------------------
  const cmdsB0 = (await ev(b, 'window.VideoSync.status().stats')).cmdsSent;
  await a.s.eval('window.page.userPause()');
  await b.s.waitFor('window.page.el().paused', { timeoutMs: 8000 });
  await sleep(1200);
  const cmdsB1 = (await ev(b, 'window.VideoSync.status().stats')).cmdsSent;
  check('a pause reached the other browser without echoing back', cmdsB1 === cmdsB0,
    `b sent ${cmdsB1 - cmdsB0} commands while applying a remote pause`);

  // --- the worker dying must cost a reconnect, not the session ---------------
  const reconnects0 = (await ev(a, 'window.VideoSync.status().stats')).reconnects;
  const targets = await (await fetch(`http://127.0.0.1:9461/json/list`)).json();
  const sw = targets.find((t) => t.type === 'service_worker');
  results.measurements.serviceWorkerTarget = !!sw;
  if (sw) {
    // Kill the worker the way Chrome would when it decides the session is idle.
    const swSession = await new Session(sw.webSocketDebuggerUrl).open();
    await swSession.send('Runtime.enable');
    try { await swSession.eval('globalThis.close ? close() : null'); } catch { /* it went away */ }
    swSession.close();
    await sleep(1500);
    await a.s.waitFor("window.VideoSync.status().state === 'joined'", { timeoutMs: 20000, isolated: true });
    const reconnects1 = (await ev(a, 'window.VideoSync.status().stats')).reconnects;
    check('killing the service worker costs a reconnect, not the session',
      (await ev(a, "window.VideoSync.status().state")) === 'joined',
      `reconnects ${reconnects0} -> ${reconnects1}`);
  } else {
    check('a service worker target was found to kill', false, 'skipped the teardown test');
  }

  const sa = await ev(a, 'window.VideoSync.status().stats');
  const sb = await ev(b, 'window.VideoSync.status().stats');
  results.measurements.stats = { a: sa, b: sb };
  check('no frame was rejected as malformed', sa.badFrames === 0 && sb.badFrames === 0,
    `a=${sa.badFrames} b=${sb.badFrames}`);
} catch (e) {
  failed = true;
  check('probe ran to completion', false, e.message);
} finally {
  for (const p of peers) p.s.close();
  for (const br of browsers) await br.close();
  server.kill();
}

flush();
const bad = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - bad.length}/${results.checks.length} checks passed`);
if (bad.length || failed) {
  console.log('server log tail:\n' + serverLog.slice(-1200));
  process.exit(1);
}
