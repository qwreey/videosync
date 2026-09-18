/**
 * The panel where a member actually watches: fullscreen, and with the
 * connection down (STATE.md "Round 5: nothing done offline is sent").
 *
 * Three things only a browser can answer:
 *   - the panel is in the top layer (`popover`), so it paints over a site's
 *     fullscreen player instead of being hidden by it;
 *   - a press on the panel does not reach the site's own player handlers (the
 *     shadow root stops pointer events), so pressing 접기 or 나가기 over the
 *     player does not play or pause the room;
 *   - the disconnect banner appears while the session is down -- collapsed
 *     and fullscreen included -- and goes away when the room is back.
 *
 * Member A is a Helium tab on $E1 with the `local-ext.mjs` build (the panel's
 * root must be open). It reaches videosyncd through a TCP relay in this
 * process, which the probe cuts to make the banner appear, exactly as
 * probe-offline.mjs does. RESULT=<name> names the results file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const UP_PORT = +(process.env.UP_PORT || 8787);
const RELAY_PORT = +(process.env.RELAY_PORT || 8788);
const RELAYED = `http://127.0.0.1:${RELAY_PORT}`;
const E1 = process.env.E1 || 'https://laftel.net/player/45462/93304';
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT = join(HERE, 'results', `${process.env.RESULT || 'panel'}.json`);

const results = { when: new Date().toISOString(), page: E1, relay: RELAYED, checks: [], notes: [] };
function flush() {
  mkdirSync(dirname(RESULT), { recursive: true });
  writeFileSync(RESULT, JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}

let up = true;
const live = new Set();
const relay = net.createServer((c) => {
  if (!up) { c.destroy(); return; }
  const s = net.connect(UP_PORT, '127.0.0.1');
  live.add(c); live.add(s);
  const drop = () => { c.destroy(); s.destroy(); live.delete(c); live.delete(s); };
  c.on('error', drop); s.on('error', drop); c.on('close', drop); s.on('close', drop);
  c.pipe(s); s.pipe(c);
});

/** What the panel looks like from the page's side, and from ours. */
const LOOK = `(() => {
  const host = document.getElementById('videosync-root');
  const r = VideoSync.panelRoot();
  const panel = r.querySelector('.panel');
  const banner = r.querySelector('.banner');
  const q = panel.getBoundingClientRect();
  const mid = { x: q.x + q.width / 2, y: q.y + 8 };
  const bq = banner ? banner.getBoundingClientRect() : null;
  return {
    hostParent: host.parentElement ? host.parentElement.tagName : null,
    popover: host.getAttribute('popover'),
    open: typeof host.matches === 'function' ? host.matches(':popover-open') : null,
    panel: { x: q.x, y: q.y, w: q.width, h: q.height },
    // Who gets a click at the panel's header: our host, or the site?
    hitTop: (document.elementFromPoint(mid.x, mid.y) || {}).id ?? null,
    collapsed: panel.className.includes('collapsed'),
    panelClass: panel.className,
    readOnly: panel.className.includes('fullscreen'),
    headButtons: [...r.querySelectorAll('.head button')].filter((b) => getComputedStyle(b).display !== 'none').length,
    bannerShown: banner ? banner.className.includes('on') : null,
    bannerBox: bq ? { w: bq.width, h: bq.height } : null,
    fullscreen: !!document.fullscreenElement,
    fsTag: document.fullscreenElement ? document.fullscreenElement.tagName : null,
    video: (() => { const v = document.querySelector('video'); return v ? { paused: v.paused, t: v.currentTime } : null; })(),
  };
})()`;

async function main() {
  await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
  const t = (await (await fetch(`${CDP}/json/list`)).json())
    .find((x) => x.type === 'page' && x.url.startsWith(E1));
  if (!t) throw new Error(`no tab on ${E1}`);
  const s = await new Session(t.webSocketDebuggerUrl).open();
  s.trackContexts();
  s.isolatedName = 'VideoSync';
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  await s.send('Page.bringToFront');
  const iso = (body) => s.evalIsolated(`(async () => { ${body} })()`);
  await s.waitFor('typeof VideoSync === "object"', { isolated: true, timeoutMs: 30000 });
  if ((await iso('return VideoSync.status().state')) !== 'idle') await iso('VideoSync.leave(); return 1');
  await iso('await VideoSync.adapter.pause(); return 1');

  const look = () => iso(`return ${LOOK}`);
  /** A trusted click at (x, y). */
  const click = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(60);
    }
    await sleep(400);
  };
  const headButton = () => iso(`const r = VideoSync.panelRoot();
    const b = r.querySelector('.head button'); const q = b.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };`);

  // --- 1. the top layer, windowed --------------------------------------------
  let v = await look();
  results.windowed = v;
  check('the panel host is a shown popover under <html>', v.hostParent === 'HTML' && v.popover === 'manual' && v.open === true,
    `parent ${v.hostParent}, popover ${v.popover}, open ${v.open}`);
  check('and a click on its header lands on the panel, not the site', v.hitTop === 'videosync-root', `hit ${v.hitTop}`);

  // --- 2. fullscreen ----------------------------------------------------------
  // requestFullscreen needs user activation: a trusted key press gives it.
  await s.eval(`document.addEventListener('keydown', function h(e) {
    if (e.key !== 'F2') return; document.removeEventListener('keydown', h);
    (document.querySelector('video').closest('[class*=player], [id*=player]') || document.querySelector('video')).requestFullscreen();
  }); 1`);
  for (const type of ['keyDown', 'keyUp']) {
    await s.send('Input.dispatchKeyEvent', { type, key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
  }
  await sleep(1500);
  v = await look();
  results.fullscreen = v;
  if (!v.fullscreen) {
    results.notes.push('the site did not go fullscreen; the fullscreen checks were skipped');
    check('the site went fullscreen', false, 'no fullscreenElement');
  } else {
    check('the site went fullscreen', true, `${v.fsTag}`);
    check('the panel still paints there (top layer)', v.panel.w > 0 && v.panel.h > 0,
      `box ${Math.round(v.panel.w)}x${Math.round(v.panel.h)}`);
    // Measured: nothing outside the fullscreen subtree is hit tested, so the
    // panel cannot be pressed there -- which is why its controls are hidden.
    check('the panel is a read-out there: no controls to press', v.readOnly === true && v.headButtons === 0,
      `class ${v.panelClass}, head buttons ${v.headButtons}`);
    check('and the hit test confirms why: the site owns the pointer', v.hitTop !== 'videosync-root', `hit ${v.hitTop || '(site)'}`);
  }

  // --- 3. the banner ----------------------------------------------------------
  const room = await iso(`return await VideoSync.createRoom(${JSON.stringify(RELAYED)}, 'a')`);
  await s.waitFor("VideoSync.status().state === 'joined'", { isolated: true, timeoutMs: 20000 });
  results.roomId = room.roomId;
  v = await look();
  check('no banner while the room is reachable', v.bannerShown === false, `shown ${v.bannerShown}`);

  up = false;
  for (const x of live) x.destroy();
  live.clear();
  await s.waitFor("VideoSync.status().state !== 'joined'", { isolated: true, timeoutMs: 30000 });
  await sleep(500);
  v = await look();
  results.cut = v;
  check('the banner is up while the session is down', v.bannerShown === true && v.bannerBox.w > 0 && v.bannerBox.h > 0,
    `shown ${v.bannerShown}, box ${v.bannerBox ? Math.round(v.bannerBox.w) + 'x' + Math.round(v.bannerBox.h) : 'none'}`);
  check('it is visible in fullscreen too', !v.fullscreen || (v.bannerBox.w > 0 && v.bannerBox.h > 0),
    `fullscreen ${v.fullscreen}, banner box ${v.bannerBox ? Math.round(v.bannerBox.w) + 'x' + Math.round(v.bannerBox.h) : 'none'}`);

  if (!v.fullscreen) {
    const btn3 = await headButton();
    await click(btn3.x, btn3.y);                      // collapse
    const collapsed = await look();
    results.cutCollapsed = collapsed;
    check('and it survives a collapsed panel', collapsed.collapsed === true && collapsed.bannerShown === true &&
      collapsed.bannerBox.h > 0, `collapsed ${collapsed.collapsed}, banner ${collapsed.bannerShown}, h ${collapsed.bannerBox?.h}`);
    const btn4 = await headButton();
    await click(btn4.x, btn4.y);                      // expand again
  } else {
    results.notes.push('collapsed check skipped: the panel cannot be pressed while the site is fullscreen');
  }

  up = true;
  await s.waitFor("VideoSync.status().state === 'joined'", { isolated: true, timeoutMs: 40000 });
  await sleep(1000);
  v = await look();
  results.restored = v;
  check('the banner goes away when the room is back', v.bannerShown === false, `shown ${v.bannerShown}`);

  await iso('VideoSync.leave(); return 1');
  if (v.fullscreen) await s.eval('document.exitFullscreen(); 1').catch(() => {});
  const passed = results.checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${results.checks.length} passed`);
  flush();
  relay.close();
  process.exit(passed === results.checks.length ? 0 : 1);
}

main().catch((e) => { results.notes.push(`error: ${e.stack}`); flush(); console.error(e); process.exit(1); });
