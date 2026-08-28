/**
 * Can a script running on an https OTT page reach a self-hosted sync server?
 *
 * Split out of probe-youtube.mjs because it is a deployment question, not a
 * player question, and because the answer decides how the product is installed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYNC_PORT = 8788;
const out = { checks: [], notes: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const bin = join(process.cwd(), 'dist', 'videosyncd');
if (!existsSync(bin)) { console.error('no videosyncd in dist/'); process.exit(2); }
const server = spawn(bin, ['-addr', `127.0.0.1:${SYNC_PORT}`], { stdio: 'ignore' });
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${SYNC_PORT}/healthz`)).ok) break; } catch {}
  await sleep(100);
}

const b = await launch({ port: 9421, headful: true, extraFlags: ['--window-size=800,600'] });
let s = null;
try {
  const tab = await newTab(9421, 'about:blank');
  s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  for (const [label, page] of [
    ['http page', `http://127.0.0.1:${process.env.PORT || 8899}/sync-page.html`],
    ['https page (youtube.com)', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  ]) {
    await s.send('Page.navigate', { url: page });
    await s.waitFor('document.readyState === "complete" || document.readyState === "interactive"',
      { timeoutMs: 60000 });
    await sleep(1500);
    const origin = await s.eval('location.origin');

    const cors = await s.eval(`
      Promise.race([
        fetch('http://127.0.0.1:${SYNC_PORT}/api/rooms', { method: 'POST', body: '{}' })
          .then(r => r.json()).then(j => ({ ok: true, roomId: j.roomId }), e => ({ ok: false, err: String(e) })),
        new Promise(r => setTimeout(() => r({ ok: false, err: 'timeout' }), 6000)),
      ])`);
    check(`${label}: cross-origin POST /api/rooms`, cors.ok, `${origin} -> ${cors.ok ? cors.roomId : cors.err}`);

    const ws = await s.eval(`
      new Promise((res) => {
        let w;
        try { w = new WebSocket('ws://127.0.0.1:${SYNC_PORT}/ws'); }
        catch (e) { return res({ ok: false, stage: 'construct', err: String(e && e.name) }); }
        const t = setTimeout(() => res({ ok: false, stage: 'timeout' }), 6000);
        w.onopen = () => { clearTimeout(t); try { w.close(); } catch {} res({ ok: true }); };
        w.onerror = () => { clearTimeout(t); res({ ok: false, stage: 'error' }); };
      })`);
    check(`${label}: ws:// to the sync server`, ws.ok, `${origin} -> ${ws.ok ? 'open' : ws.stage + (ws.err ? ' ' + ws.err : '')}`);
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  s?.close();
  await b.close();
  server.kill();
}
mkdirSync('results', { recursive: true });
writeFileSync('results/csp.json', JSON.stringify(out, null, 2));
const bad = out.checks.filter((c) => !c.ok).length;
console.log(`\n${out.checks.length - bad}/${out.checks.length} checks passed`);
