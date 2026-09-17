/**
 * Review round 3, in a real browser (STATE.md "Review round 3").
 *
 * Two behaviours the round changed that only a browser can confirm:
 *
 *   N37  A member who arrived by invite link keeps `#videosync=<room>.<secret>`
 *        in the address bar. When the room rotates its secret, the page must
 *        rewrite that fragment (`history.replaceState`) without disturbing the
 *        site: same path, same `history.state`, no reload, the player untouched.
 *        A reload then prefills the NEW secret and joining works.
 *   N1   A member whose tab is in the background (media never loads there,
 *        BROWSER-FINDINGS §5b) must be reported absent, not judged: before the
 *        fix its readyState 0 gated every `play` for GATE_TIMEOUT (30 s).
 *
 * Attaches over CDP like probe-follow.mjs: a logged-in Helium with a
 * `local-ext.mjs` build (the panel's root must be open), two tabs, and a
 * videosyncd at $SERVER. RESULT=<name> names the results file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
const E1 = process.env.E1 || 'https://laftel.net/player/45462/93304';
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT = join(HERE, 'results', `${process.env.RESULT || 'round3'}.json`);

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

async function targets() {
  return (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page');
}
async function attach(id) {
  const t = (await targets()).find((x) => x.id === id);
  const s = await new Session(t.webSocketDebuggerUrl).open();
  s.trackContexts();
  s.isolatedName = 'VideoSync';
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  return s;
}
const iso = (s, body) => s.evalIsolated(`(async () => { ${body} })()`);
const inputs = (s) => iso(s, `return [...VideoSync.panelRoot().querySelectorAll('input')].map((x) => x.value)`);

async function navigate(s, url) {
  await s.send('Page.navigate', { url });
  const t0 = Date.now();
  for (;;) {
    let href = '';
    try { href = await s.eval('location.href'); } catch { /* mid-navigation */ }
    if (href === url) break;
    if (Date.now() - t0 > 20000) throw new Error(`never reached ${url}; at ${href}`);
    await sleep(200);
  }
  await s.waitFor('typeof VideoSync === "object" && VideoSync.adapter.readState().readyState >= 1',
    { isolated: true, timeoutMs: 30000 });
}

async function main() {
  const tabs = await targets();
  const ta = tabs.find((x) => x.url.startsWith('https://laftel.net/player/') || x.url.startsWith(E1));
  const tb = tabs.find((x) => x.id !== ta?.id);
  if (!ta || !tb) throw new Error('need two tabs, one on the player');
  const a = await attach(ta.id);
  const b = await attach(tb.id);
  await navigate(a, E1);
  await iso(a, 'await VideoSync.adapter.pause(); return 1');

  // --- N37 -----------------------------------------------------------------
  const room = await iso(a, `return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')`);
  await a.waitFor("VideoSync.status().state === 'joined'", { isolated: true });
  results.roomId = room.roomId;
  const invite = `${E1}#videosync=${encodeURIComponent(room.roomId)}.${encodeURIComponent(room.secret)}`;
  // From another document: onto the same page, only the fragment would change,
  // which is a same-document navigation and loads nothing.
  await b.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  await navigate(b, invite);
  const pre = await inputs(b);
  check('an invite link prefills the room and its secret', pre.includes(room.roomId) && pre.includes(room.secret));
  await iso(b, `VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'b'); return 1`);
  await b.waitFor("VideoSync.status().state === 'joined' && VideoSync.status().members >= 2", { isolated: true, timeoutMs: 20000 });

  const before = {
    path: await b.eval('location.pathname + location.search'),
    state: await b.eval('JSON.stringify(history.state)'),
    length: await b.eval('history.length'),
    src: await iso(b, 'return document.querySelector("video")?.currentSrc ?? ""'),
  };
  await b.eval('window.__r3 = { hashchange: 0, popstate: 0 }; addEventListener("hashchange", () => __r3.hashchange++); addEventListener("popstate", () => __r3.popstate++); 1');
  await iso(a, 'VideoSync.engine().rotateSecret(); return 1');
  await a.waitFor(`VideoSync.engine().secret !== ${JSON.stringify(room.secret)}`, { isolated: true, timeoutMs: 10000 });
  const fresh = await iso(a, 'return VideoSync.engine().secret');
  let hash = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    hash = await b.eval('location.hash');
    if (hash.includes(encodeURIComponent(fresh))) break;
    await sleep(100);
  }
  check('the rotated secret is written into the address bar', hash === `#videosync=${encodeURIComponent(room.roomId)}.${encodeURIComponent(fresh)}`,
    `${Date.now() - t0} ms`);
  const after = {
    path: await b.eval('location.pathname + location.search'),
    state: await b.eval('JSON.stringify(history.state)'),
    length: await b.eval('history.length'),
    src: await iso(b, 'return document.querySelector("video")?.currentSrc ?? ""'),
    events: await b.eval('JSON.stringify(__r3)'),
  };
  results.historyState = { before: before.state, after: after.state };
  check('the site is untouched: path, history.state, history length, no reload',
    after.path === before.path && after.state === before.state && after.length === before.length &&
    after.src === before.src && await b.eval('typeof __r3') === 'object',
    `state ${before.state === after.state ? 'kept' : `${before.state} -> ${after.state}`}, length ${before.length} -> ${after.length}`);
  check('no hashchange or popstate fired', after.events === '{"hashchange":0,"popstate":0}', after.events);
  const bSt = await iso(b, 'return VideoSync.status()');
  check('the member is still in the room', bSt.state === 'joined' && bSt.members >= 2, `${bSt.members} members`);

  await b.send('Page.reload', {});
  await sleep(1000);
  await b.waitFor('typeof VideoSync === "object"', { isolated: true, timeoutMs: 30000 });
  await sleep(1500);
  const re = await inputs(b);
  check('a reload prefills the new secret', re.includes(fresh) && !re.includes(room.secret));
  const st = await iso(b, 'return VideoSync.status()');
  if (st.state !== 'joined') {
    await iso(b, `const btn = [...VideoSync.panelRoot().querySelectorAll('button')].find((x) => x.textContent === '참가'); btn?.click(); return !!btn`);
  }
  let joined = null;
  try {
    await b.waitFor("VideoSync.status().state === 'joined' && VideoSync.status().members >= 2", { isolated: true, timeoutMs: 20000 });
    joined = await iso(b, 'return VideoSync.status()');
  } catch (e) { results.notes.push(`rejoin after reload: ${e.message}`); }
  check('and joining from it works', joined !== null, joined ? `${joined.members} members, was ${st.state} after the reload` : '');
  await iso(b, 'VideoSync.leave(); return 1');

  // --- N1 ------------------------------------------------------------------
  await iso(a, 'await VideoSync.adapter.pause(); return 1');
  const browser = await new Session((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl).open();
  const bg = await browser.send('Target.createTarget', { url: `${E1}#videosync=${encodeURIComponent(room.roomId)}.${encodeURIComponent(fresh)}`, background: true });
  await sleep(1500);
  const c = await attach(bg.targetId);
  await c.waitFor('typeof VideoSync === "object"', { isolated: true, timeoutMs: 30000 });
  check('the background tab is hidden', await c.eval('document.visibilityState') === 'hidden');
  await iso(c, `VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(fresh)}, 'c'); return 1`);
  await a.waitFor('VideoSync.status().members >= 2', { isolated: true, timeoutMs: 20000 });
  await sleep(4000);
  const cSt = await iso(c, 'return VideoSync.status()');
  results.hiddenMember = cSt;
  check('the hidden member has no media', cSt.readyState === 0, `readyState ${cSt.readyState}, acquisition ${cSt.acquisition}`);
  const aBefore = await iso(a, 'return VideoSync.status()');
  check('A is not waiting on the hidden member', aBefore.waitingOn.length === 0, JSON.stringify(aBefore.waitingOn));

  const p0 = await iso(a, 'return VideoSync.adapter.readState().positionS');
  const tPress = Date.now();
  await iso(a, 'await VideoSync.adapter.play(); return 1');
  let startedAfter = null;
  while (Date.now() - tPress < 35000) {
    const s = await iso(a, 'const s = VideoSync.adapter.readState(); return { p: s.positionS, paused: s.paused }');
    if (!s.paused && s.p > p0 + 0.3) { startedAfter = Date.now() - tPress; break; }
    await sleep(100);
  }
  const aAfter = await iso(a, 'return VideoSync.status()');
  results.presser = aAfter;
  check('A\'s play starts at once, not after the gate timeout', startedAfter !== null && startedAfter < 3000,
    `started after ${startedAfter} ms, playsHeld ${aAfter.stats?.playsHeld}, waitingOn ${JSON.stringify(aAfter.waitingOn)}`);
  const cEnd = await iso(c, 'return VideoSync.status()');
  check('and the hidden member was not moved', cEnd.positionS === cSt.positionS, `${cSt.positionS} -> ${cEnd.positionS}`);

  await iso(c, 'VideoSync.leave(); return 1');
  await browser.send('Target.closeTarget', { targetId: bg.targetId }).catch(() => {});
  await iso(a, 'VideoSync.leave(); await VideoSync.adapter.pause(); return 1');
  const passed = results.checks.filter((x) => x.ok).length;
  console.log(`\n${passed}/${results.checks.length} passed`);
  flush();
  process.exit(passed === results.checks.length ? 0 : 1);
}

main().catch((e) => { results.notes.push(`error: ${e.stack}`); flush(); console.error(e); process.exit(1); });
