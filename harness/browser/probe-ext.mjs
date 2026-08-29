/**
 * What is an MV3 content script allowed to do?
 *
 * This decides the extension's architecture, and it was worth measuring before
 * writing a line of it. If the content script can hold the WebSocket itself,
 * the session lives as long as the tab and MV3's service-worker lifetime -- the
 * single reason the extension was sequenced last -- stops being a risk.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYNC_PORT = 8788;
const out = { pages: {}, notes: [] };

const bin = join(process.cwd(), 'dist', 'videosyncd');
if (!existsSync(bin)) { console.error('no videosyncd in dist/'); process.exit(2); }
const server = spawn(bin, ['-addr', `127.0.0.1:${SYNC_PORT}`], { stdio: 'ignore' });
// A second instance with TLS, which is the shipping configuration: an https
// page can reach neither http nor ws (BROWSER-FINDINGS section 8).
const tlsServer = spawn(bin, ['-addr', '127.0.0.1:8789',
  '-tls-cert', join(process.cwd(), 'dist', 'dev-cert.pem'),
  '-tls-key', join(process.cwd(), 'dist', 'dev-key.pem')], { stdio: 'ignore' });
// Both servers must actually be up before the browser starts, or every result
// below reads as "the browser blocked it" when the truth is "nothing was
// listening" -- which is exactly how one run of this probe lied.
async function waitUp(url, label) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await sleep(100);
  }
  console.error(`FATAL: ${label} never listened at ${url}`);
  return false;
}
const plainUp = await waitUp(`http://127.0.0.1:${SYNC_PORT}/healthz`, 'plaintext videosyncd');
// Node verifies certificates and this one is self-signed for the browser's
// benefit, so check the TLS listener at the socket level instead of trusting a
// fetch option that undici may not honour.
const tlsUp = await (async () => {
  const { connect } = await import('node:tls');
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((res) => {
      const c = connect({ host: '127.0.0.1', port: 8789, rejectUnauthorized: false }, () => {
        c.end(); res(true);
      });
      c.on('error', () => res(false));
      setTimeout(() => { try { c.destroy(); } catch {} res(false); }, 500);
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
})();
out.servers = { plaintext: plainUp, tls: tlsUp };
console.log(`servers: plaintext=${plainUp} tls=${tlsUp}`);
if (!plainUp || !tlsUp) {
  console.error('refusing to measure with a server down');
  server.kill(); tlsServer.kill();
  process.exit(2);
}
const spki = readFileSync(join(process.cwd(), 'dist', 'dev-cert.spki'), 'utf8').trim();

// A bare listener that logs everything it is asked, so we can tell "the browser
// refused to send the request" from "the request arrived and we answered it
// wrong". Those two look identical from the page: both hang.
const seen = [];
const { createServer } = await import('node:http');
const spy = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, origin: req.headers.origin || null,
    pna: req.headers['access-control-request-private-network'] || null });
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-private-network': 'true',
  });
  res.end();
});
await new Promise((r) => spy.listen(8790, '127.0.0.1', r));

const ext = join(process.cwd(), 'ext-probe');
const b = await launch({
  port: 9431, headful: true,
  extraFlags: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--window-size=900,700',
    // Trust exactly this development certificate and nothing else. Not
    // --ignore-certificate-errors: the question here is whether the SCHEME is
    // permitted, and switching off certificate validation wholesale would
    // make the result mean less than it should.
    `--ignore-certificate-errors-spki-list=${spki}`,
  ],
});
let s = null;
try {
  const tab = await newTab(9431, 'about:blank');
  s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  for (const [label, url] of [
    ['http', `http://127.0.0.1:${process.env.PORT || 8899}/sync-page.html`],
    ['https-youtube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  ]) {
    await s.send('Page.navigate', { url });
    await s.waitFor('document.readyState !== "loading"', { timeoutMs: 60000 });
    let data = null;
    // Generous: on an https page most of these calls are blocked, and a
    // blocked call does not fail -- it hangs until its own timeout. The whole
    // sweep can take half a minute, and a poll window shorter than that reads
    // as "the content script never ran".
    for (let i = 0; i < 180; i++) {
      data = await s.eval('document.documentElement.getAttribute("data-videosync-probe")');
      if (data) break;
      await sleep(500);
    }
    if (!data) {
      out.pages[label] = { error: 'the content script never reported (did it run at all?)' };
      console.log(`FAIL  ${label}: content script never reported`);
      continue;
    }
    const parsed = JSON.parse(data);
    out.pages[label] = parsed;
    console.log(`\n=== ${label} (${parsed.origin}) ===`);
    for (const [k, v] of Object.entries(parsed.results)) {
      console.log(`  ${v.ok ? 'PASS' : 'FAIL'}  ${k}${v.ok ? '' : `  ${v.err}`}`);
    }
    out.pages[label].spyRequests = seen.splice(0);
    console.log(`  spy saw ${out.pages[label].spyRequests.length} request(s): ` +
      JSON.stringify(out.pages[label].spyRequests));
    // Clear it so the next page's result cannot be mistaken for this one's.
    await s.eval('document.documentElement.removeAttribute("data-videosync-probe")');
  }
} catch (e) {
  out.error = e.message;
  console.log(`probe threw: ${e.message}`);
} finally {
  s?.close();
  await b.close();
  server.kill();
  tlsServer.kill();
  spy.close();
}
mkdirSync('results', { recursive: true });
writeFileSync('results/ext-capabilities.json', JSON.stringify(out, null, 2));
console.log('\nwrote results/ext-capabilities.json');
