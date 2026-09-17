/**
 * N37 in Firefox (STATE.md "Review round 3"; probe-round3.mjs is the Chromium
 * half). The rewrite of an invite fragment runs in the content script, whose
 * `history` is an Xray view of the page's: `history.replaceState(history.state,
 * ...)` has to hand the site's own state back to it intact, or a SPA like
 * Laftel loses its router state. Only Firefox has that wrapper.
 *
 * Member A is Helium over CDP on $E1 (the room's creator and the one who
 * rotates); member B is Firefox over BiDi with the local-ext.mjs build at
 * $FF_EXT, driven through the panel. RESULT=<name> names the results file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Bidi } from './bidi.mjs';
import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
const E1 = process.env.E1 || 'https://laftel.net/player/45462/93304';
const HERE = dirname(fileURLToPath(import.meta.url));
const FF_EXT = process.env.FF_EXT || join(HERE, '..', '..', '.cache', 'firefox-profile', 'ext-local');
const RESULT = join(HERE, 'results', `${process.env.RESULT || 'round3-firefox'}.json`);

const results = { when: new Date().toISOString(), server: SERVER, page: E1, checks: [], notes: [] };
function flush() {
  mkdirSync(dirname(RESULT), { recursive: true });
  writeFileSync(RESULT, JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}

const PANEL = `document.getElementById('videosync-root')?.shadowRoot`;
const inputs = (b, ctx) => b.eval(ctx, `[...(${PANEL}).querySelectorAll('input')].map((x) => x.value)`);
const joinVia = (b, ctx) => b.eval(ctx, `(() => { const r = ${PANEL};
  const set = (ph, v) => { const i = [...r.querySelectorAll('input')].find((x) => x.placeholder === ph); if (!i.value) i.value = v; };
  set('http://localhost:8787', ${JSON.stringify(SERVER)}); set('이름', 'firefox');
  [...r.querySelectorAll('button')].find((x) => x.textContent === '참가').click(); return 1; })()`);
const joined = (b, ctx) => b.waitFor(ctx, `(${PANEL})?.querySelector('.dot')?.className.includes('joined')`, { timeoutMs: 30000 });

let bidi = null;
async function main() {
  const list = (await (await fetch('http://127.0.0.1:9222/json/list')).json())
    .filter((x) => x.type === 'page' && x.url.startsWith(E1));
  if (!list.length) throw new Error(`no Chromium tab on ${E1}`);
  const a = await new Session(list[0].webSocketDebuggerUrl).open();
  a.trackContexts();
  a.isolatedName = 'VideoSync';
  await a.send('Runtime.enable');
  const isoA = (body) => a.evalIsolated(`(async () => { ${body} })()`);
  if ((await isoA('return VideoSync.status().state')) !== 'idle') await isoA('VideoSync.leave(); return 1');
  await isoA('await VideoSync.adapter.pause(); return 1');
  const room = await isoA(`return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'chromium')`);
  await a.waitFor("VideoSync.status().state === 'joined'", { isolated: true });
  results.roomId = room.roomId;

  const b = await Bidi.connect();
  bidi = b;
  try { await b.installExtension(FF_EXT); } catch (e) { results.notes.push(`install: ${e.message}`); }
  const invite = `${E1}#videosync=${encodeURIComponent(room.roomId)}.${encodeURIComponent(room.secret)}`;
  const ctx = await b.newTab(invite);
  await b.waitFor(ctx, `!!${PANEL}`, { timeoutMs: 30000 });
  await sleep(3000);
  const pre = await inputs(b, ctx);
  check('an invite link prefills the room and its secret', pre.includes(room.roomId) && pre.includes(room.secret));
  await joinVia(b, ctx);
  await joined(b, ctx);
  await a.waitFor('VideoSync.status().members === 2', { isolated: true, timeoutMs: 15000 });

  // Give the page a state of its own that a lossy copy would visibly change:
  // Laftel's router state plus a nested object, a Date and a Map.
  await b.eval(ctx, `(() => { const s = history.state;
    history.replaceState({ ...(s && typeof s === 'object' ? s : {}), __r3: { n: 1, list: [1, 'x', null], at: new Date(0), m: new Map([[1, 2]]) } }, '');
    window.__r3events = { hashchange: 0, popstate: 0 };
    addEventListener('hashchange', () => __r3events.hashchange++);
    addEventListener('popstate', () => __r3events.popstate++); return 1; })()`);
  const snap = () => b.eval(ctx, `JSON.stringify({ path: location.pathname + location.search, length: history.length,
    state: history.state, date: history.state?.__r3?.at instanceof Date, map: history.state?.__r3?.m instanceof Map && history.state.__r3.m.get(1) === 2 })`);
  const before = JSON.parse(await snap());
  results.before = before;

  await isoA('VideoSync.engine().rotateSecret(); return 1');
  await a.waitFor(`VideoSync.engine().secret !== ${JSON.stringify(room.secret)}`, { isolated: true, timeoutMs: 10000 });
  const fresh = await isoA('return VideoSync.engine().secret');
  const want = `#videosync=${encodeURIComponent(room.roomId)}.${encodeURIComponent(fresh)}`;
  const t0 = Date.now();
  let hash = '';
  while (Date.now() - t0 < 5000) {
    hash = await b.eval(ctx, 'location.hash');
    if (hash === want) break;
    await sleep(100);
  }
  check('the rotated secret is written into the address bar', hash === want, `${Date.now() - t0} ms`);
  const after = JSON.parse(await snap());
  results.after = after;
  check('the site\'s history.state survives the Xray round trip',
    JSON.stringify(after.state) === JSON.stringify(before.state) && after.date && after.map,
    `Date ${after.date}, Map ${after.map}`);
  check('same path and history length', after.path === before.path && after.length === before.length,
    `length ${before.length} -> ${after.length}`);
  check('no hashchange or popstate fired', await b.eval(ctx, 'JSON.stringify(__r3events)') === '{"hashchange":0,"popstate":0}');

  await b.send('browsingContext.reload', { context: ctx, wait: 'complete' });
  await b.waitFor(ctx, `!!${PANEL}`, { timeoutMs: 30000 });
  await sleep(3000);
  const re = await inputs(b, ctx);
  check('a reload prefills the new secret', re.includes(fresh) && !re.includes(room.secret));
  if (!(await b.eval(ctx, `(${PANEL}).querySelector('.dot').className.includes('joined')`))) await joinVia(b, ctx);
  let ok = true;
  try { await joined(b, ctx); } catch { ok = false; }
  check('and joining from it works', ok);

  await b.eval(ctx, `(() => { [...(${PANEL}).querySelectorAll('button')].find((x) => x.textContent === '나가기').click(); return 1; })()`);
  await isoA('VideoSync.leave(); return 1');
  await b.send('browsingContext.close', { context: ctx });
  await b.close();
  a.close();
}

main().then(() => {
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} passed`);
  process.exit(failed ? 1 : 0);
}).catch(async (e) => {
  results.notes.push(`aborted: ${e.message}`);
  flush();
  console.error(e);
  await bidi?.close();
  process.exit(1);
});
