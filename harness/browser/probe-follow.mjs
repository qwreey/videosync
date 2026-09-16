/**
 * Joining by code takes you to the room's video, and the room keeps taking
 * you there when it moves (STATE.md "3", user request 2026-08-31).
 *
 * Attaches over CDP like probe-laftel.mjs: needs a logged-in browser with the
 * extension, one tab on a Laftel episode (the creator), one on YouTube (the
 * joiner -- deliberately another provider, the ordinary "friend sends a code"
 * case), and a videosyncd at $SERVER.
 *
 *   1. A creates a room on episode E1.
 *   2. B, on YouTube, joins by code: it must be navigated to E1 and rejoin the
 *      same room on arrival, with nobody pressing anything.
 *   3. A moves to episode E2 inside Laftel's SPA and presses "move the room
 *      here": B must follow to E2 and rejoin again.
 *   4. A local navigation by B must NOT be undone by the room.
 *   5. "Stay here" during the grace period keeps B where it is.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
const E1 = 'https://laftel.net/player/45462/93304';
const E2 = 'https://laftel.net/player/45462/93295';
const YT = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const HERE = dirname(fileURLToPath(import.meta.url));

const results = { when: new Date().toISOString(), checks: [], notes: [] };
function flush() {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, 'results/follow.json'), JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}

async function targets() {
  return (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page');
}

/** A session on a tab, identified by target id, that survives navigations. */
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

async function waitUrl(s, pred, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    let href = '';
    try { href = await s.eval('location.href'); } catch { /* mid-navigation */ }
    if (pred(href)) return href;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}; at ${href}`);
    await sleep(200);
  }
}

async function waitJoined(s, roomId, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const st = await iso(s, 'return VideoSync.status()');
      if (st.state === 'joined' && st.members >= 2) return st;
    } catch { /* the content script is still starting */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`never rejoined ${roomId}`);
    await sleep(250);
  }
}

async function main() {
  const tabs = await targets();
  const ta = tabs.find((x) => x.url.startsWith('https://laftel.net/player/'));
  const tb = tabs.find((x) => x.id !== ta?.id);
  if (!ta || !tb) throw new Error('need a Laftel player tab and one more tab');
  const a = await attach(ta.id);
  const b = await attach(tb.id);
  await b.send('Page.navigate', { url: YT });
  await waitUrl(b, (h) => h.startsWith(YT), 20000, 'B on YouTube');
  if (!(await a.eval('location.href')).startsWith(E1)) {
    await a.send('Page.navigate', { url: E1 });
    await waitUrl(a, (h) => h.startsWith(E1), 20000, 'A on E1');
  }
  for (const s of [a, b]) {
    await s.waitFor('!!window.VideoSync', { isolated: true, timeoutMs: 20000 });
    if ((await iso(s, 'return VideoSync.status().state')) !== 'idle') await iso(s, 'VideoSync.leave(); return 1');
  }

  // 1. A creates the room on E1.
  const room = await iso(a, `return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')`);
  await a.waitFor("VideoSync.status().state === 'joined'", { isolated: true });
  results.roomId = room.roomId;

  // 2. B joins by code, from YouTube.
  const tJoin = Date.now();
  await iso(b, `VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'b'); return 1`);
  const arrived = await waitUrl(b, (h) => h.startsWith(E1), 20000, 'B to be taken to E1');
  const tArrive = Date.now();
  check('joining by code takes the member to the room\'s video', arrived === E1,
    `${YT} -> ${arrived} after ${tArrive - tJoin} ms`);
  const st1 = await waitJoined(b, room.roomId, 30000);
  check('and rejoins the same room there, unprompted', st1.roomMediaKey === 'laftel:/player/45462/93304' &&
    st1.mediaKey === st1.roomMediaKey, `rejoined after ${Date.now() - tArrive} ms, ${st1.members} members`);

  // 3. A moves to E2 inside the SPA and moves the room there.
  await a.eval(`document.querySelector('a[href="/player/45462/93295"]').click(), 1`);
  await waitUrl(a, (h) => h.startsWith(E2), 10000, 'A on E2');
  await a.waitFor("VideoSync.mediaKey() === 'laftel:/player/45462/93295'", { isolated: true });
  await sleep(500);
  const stA = await iso(a, 'return VideoSync.status()');
  check('A still in the room after its own SPA navigation', stA.state === 'joined', stA.roomMediaKey);
  // Press the panel's button, as the user would.
  const pressed = await iso(a, `
    const root = VideoSync.panelRoot();
    const btn = [...root.querySelectorAll('button')].find(x => x.textContent === '이 영상으로 방 옮기기');
    if (!btn) return false; btn.click(); return true;`);
  check('A is offered "move the room here", and presses it', pressed);
  const tMove = Date.now();
  const followed = await waitUrl(b, (h) => h.startsWith(E2), 20000, 'B to follow to E2');
  check('B follows the room to the new episode', followed === E2, `after ${Date.now() - tMove} ms`);
  const st2 = await waitJoined(b, room.roomId, 30000);
  check('and rejoins again', st2.roomMediaKey === 'laftel:/player/45462/93295' && st2.mediaKey === st2.roomMediaKey,
    `${st2.members} members`);
  const stA2 = await iso(a, 'return VideoSync.status()');
  check('A was not navigated by its own command', (await a.eval('location.href')).startsWith(E2) && stA2.state === 'joined');

  // 4. B wanders off on its own: the room must not pull it back.
  // The episode list renders after the player: wait for it.
  await b.waitFor(`[...document.querySelectorAll('a[href^="/player/45462/"]')]
    .some((x) => !location.pathname.endsWith(x.getAttribute('href')))`, { timeoutMs: 15000 });
  const away = await b.eval(`(() => {
    const a = [...document.querySelectorAll('a[href^="/player/45462/"]')]
      .find((x) => !location.pathname.endsWith(x.getAttribute('href')));
    if (!a) return null; a.click(); return a.getAttribute('href'); })()`);
  if (!away) throw new Error('no other episode link on B\'s page');
  await waitUrl(b, (h) => h.endsWith(away), 10000, 'B on another episode by its own click');
  await sleep(4000);
  const still = await b.eval('location.href');
  const stB = await iso(b, 'return VideoSync.status()');
  check('a member\'s own navigation is not undone by the room', still.endsWith(away) && stB.state === 'joined',
    `B at ${still}, room on ${stB.roomMediaKey}`);
  const offered = await iso(b, `const r = VideoSync.panelRoot();
    return [...r.querySelectorAll('button')].some((x) => x.textContent === '이 영상으로 방 옮기기' && x.offsetParent !== null);`);
  check('it is offered "move the room here" instead', offered);

  // 5. Joining can be declined: "stay here" inside the grace period.
  await iso(b, 'VideoSync.leave(); return 1');
  await b.send('Page.navigate', { url: YT });
  await waitUrl(b, (h) => h.startsWith(YT), 20000, 'B back on YouTube');
  await b.waitFor('!!window.VideoSync', { isolated: true, timeoutMs: 20000 });
  await iso(b, `VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'b'); return 1`);
  const stayed = await iso(b, `
    const r = VideoSync.panelRoot();
    for (let i = 0; i < 40; i++) {
      const btn = [...r.querySelectorAll('button')].find((x) => x.textContent === '여기 있기');
      if (btn) { btn.click(); return true; }
      await new Promise((res) => setTimeout(res, 25));
    }
    return false;`);
  check('"stay here" is offered before leaving the page', stayed);
  await sleep(3500);
  const stillYt = await b.eval('location.href');
  const stB5 = await iso(b, 'return VideoSync.status()');
  check('and declining keeps the member where they are, still in the room',
    stillYt.startsWith(YT) && stB5.state === 'joined', stillYt);

  for (const s of [a, b]) { await iso(s, 'VideoSync.leave(); return 1'); s.close(); }
}

main().then(() => {
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} passed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  results.notes.push(`aborted: ${e.message}`);
  flush();
  console.error(e);
  process.exit(1);
});
