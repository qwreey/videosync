/**
 * How long does an MV3 service worker hold a WebSocket?
 *
 * The extension's whole architecture turns on this. A content script on a
 * public-origin page cannot reach a loopback or LAN address at ALL (measured:
 * results/ext-capabilities.json -- the request never leaves the browser), so a
 * self-hosted server on the user's own machine is reachable only from the
 * service worker. If the worker cannot hold a socket, "self-hostable" and
 * "browser extension" are in tension and the product has to choose.
 *
 * The probe deliberately does two things a naive version would not:
 *  - it polls WITHOUT touching the socket, because touching it would itself be
 *    the activity that keeps the worker alive;
 *  - it records a per-worker-instance id, so a silently restarted worker is
 *    distinguishable from one that never died.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8788;
const TOTAL_MS = Number(process.env.TOTAL_MS || 240000);
const STEP_MS = Number(process.env.STEP_MS || 15000);
// A real client heartbeats every second; this asks whether traffic is what
// keeps the worker alive, so one arm sends and one arm stays silent.
const SEND_EVERY = process.env.SILENT === '1' ? 0 : 1;

const out = { totalMs: TOTAL_MS, stepMs: STEP_MS, sendsTraffic: !!SEND_EVERY, samples: [] };

const bin = join(process.cwd(), 'dist', 'videosyncd');
if (!existsSync(bin)) { console.error('no videosyncd in dist/'); process.exit(2); }
const server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {}
  await sleep(100);
}

const ext = join(process.cwd(), 'ext-life');
const b = await launch({
  port: 9441, headful: true,
  extraFlags: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-size=800,600'],
});
let s = null;
try {
  const tab = await newTab(9441,
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ' + (SEND_EVERY ? '' : '#silent'));
  s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');


  await s.waitFor('document.documentElement.getAttribute("data-vsl-started") === "1"',
    { timeoutMs: 30000 });
  console.log('worker started; now reading its own log via storage only');

  const t0 = Date.now();
  while (Date.now() - t0 < TOTAL_MS) {
    await sleep(STEP_MS);
    const raw = await s.eval('document.documentElement.getAttribute("data-vsl-log")');
    const log = raw ? JSON.parse(raw) : [];
    const instances = [...new Set(log.map((r) => r.instance))];
    const ticks = log.filter((r) => r.event === 'tick');
    const last = log.at(-1);
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s  entries=${log.length} ` +
      `instances=${instances.length} ticks=${ticks.length} last=${last ? last.event : '-'}` +
      `${last?.readyState !== undefined ? ` rs=${last.readyState}` : ''}` +
      `${last?.code ? ` code=${last.code} ${last.reason}` : ''}`);
    out.samples.push({ atMs: Date.now() - t0, entries: log.length, instances: instances.length,
      ticks: ticks.length, last });
    out.log = log;
  }

  const log = out.log || [];
  const instances = [...new Set(log.map((r) => r.instance))];
  const ticks = log.filter((r) => r.event === 'tick');
  const opens = log.filter((r) => r.event === 'open');
  const closes = log.filter((r) => r.event === 'close');
  // A tick every 10 s means the worker was alive at that moment. The largest
  // gap between consecutive ticks is how long it was NOT.
  let maxGap = 0;
  for (let i = 1; i < ticks.length; i++) maxGap = Math.max(maxGap, ticks[i].at - ticks[i - 1].at);
  out.verdict = {
    distinctWorkerInstances: instances.length,
    workerRestarted: instances.length > 1,
    opens: opens.length,
    closes: closes.map((c) => ({ code: c.code, reason: c.reason })),
    ticks: ticks.length,
    maxTickGapMs: maxGap,
    lastReadyState: ticks.at(-1)?.readyState ?? null,
    survivedMs: ticks.length ? ticks.at(-1).at - (opens[0]?.at ?? ticks[0].at) : 0,
  };
  console.log(`\nverdict: ${JSON.stringify(out.verdict, null, 1)}`);
} catch (e) {
  out.error = e.message;
  console.log(`probe threw: ${e.message}`);
} finally {
  s?.close();
  await b.close();
  server.kill();
}
mkdirSync('results', { recursive: true });
const name = SEND_EVERY ? 'sw-lifetime-traffic.json' : 'sw-lifetime-silent.json';
writeFileSync(`results/${name}`, JSON.stringify(out, null, 2));
console.log(`wrote results/${name}`);
