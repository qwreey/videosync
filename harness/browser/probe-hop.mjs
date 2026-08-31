/**
 * How much does the extension's message port cost?
 *
 * BROWSER-FINDINGS section 9 forces a split the userscript does not have: the
 * socket must live in the service worker, the `<video>` lives in the content
 * script, and therefore every position the engine judges crosses a port. This
 * design resolves position to tens of milliseconds and its dead-band argument
 * rests on knowing the measurement error, so "the hop is probably fast" is not
 * good enough -- it is a one-probe question and this is the probe.
 *
 * The number that matters is the SPREAD, not the mean: a report that carries a
 * timestamp can be compensated for a constant delay, but not for jitter.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(3);
};
const stats = (xs) => ({
  n: xs.length, min: pct(xs, 0), p50: pct(xs, 0.5), p95: pct(xs, 0.95),
  p99: pct(xs, 0.99), max: pct(xs, 1),
});

const out = { pages: {} };
const ext = join(process.cwd(), 'ext-hop');
const b = await launch({
  port: 9451, headful: true,
  extraFlags: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-size=800,600'],
});
let s = null;
try {
  for (const [label, url] of [
    ['local', `http://127.0.0.1:${process.env.PORT || 8899}/hop-page.html#n=400`],
    ['youtube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ#n=400'],
  ]) {
    const tab = await newTab(9451, url);
    s = await new Session(tab.webSocketDebuggerUrl).open();
    await s.send('Runtime.enable');
    let raw = null;
    for (let i = 0; i < 400; i++) {
      raw = await s.eval('document.documentElement.getAttribute("data-hop")');
      if (raw) { const p = JSON.parse(raw); if (p.done) break; }
      await sleep(1000);
    }
    if (!raw) { out.pages[label] = { error: 'no report' }; console.log(`FAIL ${label}: no report`); s.close(); continue; }
    const p = JSON.parse(raw);
    if (p.error) {
      out.pages[label] = { error: p.error };
      console.log(`FAIL ${label}: the content script threw\n${p.error}`);
      s.close();
      continue;
    }
    const rec = {
      origin: p.origin,
      portRtt: stats(p.port.map((r) => r.rttMs)),
      portOneWay: stats(p.port.map((r) => r.oneWayMs)),
      sendMessageRtt: stats(p.sendMessage.map((r) => r.rttMs)),
      afterIdle: p.idle,
      perfOriginsDiffer: p.perfOriginsDiffer,
    };
    out.pages[label] = rec;
    console.log(`\n=== ${label} (${p.origin}) ===`);
    console.log(`  port RTT       ${JSON.stringify(rec.portRtt)}`);
    console.log(`  port one-way   ${JSON.stringify(rec.portOneWay)}  (Date.now(), 1 ms granularity)`);
    console.log(`  sendMessage    ${JSON.stringify(rec.sendMessageRtt)}`);
    console.log(`  after idle     ${JSON.stringify(rec.afterIdle)}`);
    console.log(`  perf origins   cs=${rec.perfOriginsDiffer?.csPerf?.toFixed(1)} sw=${rec.perfOriginsDiffer?.swPerf?.toFixed(1)}`);
    s.close();
    s = null;
  }
} catch (e) {
  out.error = e.message;
  console.log(`probe threw: ${e.message}`);
} finally {
  s?.close();
  await b.close();
}
mkdirSync('results', { recursive: true });
writeFileSync('results/ext-hop.json', JSON.stringify(out, null, 2));
console.log('\nwrote results/ext-hop.json');
