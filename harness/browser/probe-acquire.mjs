/**
 * What a page does to a `<video>` when a client finds it, measured before the
 * acquisition state machine is built on it (docs/design/acquire.md,
 * research/design-acquire-video.md §5).
 *
 * Attaches to the dedicated browsers the way probe-laftel*.mjs does -- Helium
 * over CDP on :9222, Firefox over BiDi on :9223 -- and injects a RECORDER into
 * the page world before any page script runs. The recorder logs every media
 * event at the document in the capture phase (so non-bubbling events from every
 * element, picked or not), trusted input, navigation, `<video>` insertions and
 * removals, and a 10 ms poll that catches what fires no event: the load
 * algorithm's silent `paused = true`. Each entry carries the page's wall clock
 * (`timeOrigin + now`) and `navigator.userActivation`.
 *
 * The page world is fine here because this is measurement, not shipping. What
 * the extension can see is measured separately (M5): the same readings taken
 * from inside the `VideoSync` isolated world.
 *
 *   SCEN=M6,M1,M2          local media (local-media.mjs on :8898), no room
 *   SCEN=M3                MPRIS media keys (busctl), Helium
 *   SCEN=M5                page world vs isolated world activation, Helium
 *   SCEN=L1,L2,L3,L5       Laftel, logged in
 *   SCEN=Y1,Y2             YouTube (Helium: automated Firefox YouTube dies at ~40 s)
 *   SCEN=CONTROL           two members, today's extension, commands read off the wire
 *   BROWSER=firefox        M1/M2/M6/M4 through BiDi instead
 *   LABEL=...              suffix for results/acquire-<scen>[-label].json
 *   POLICY=...             recorded only: which --autoplay-policy the browser was started with
 *
 * Input kinds are recorded per measurement, because they mean different things:
 * `cdp` (Input.dispatch*, trusted, activating -- but on a Wayland desktop it can
 * arrive seconds late for an occluded window, BROWSER-FINDINGS §16), `synthetic`
 * (dispatched from page script: no activation, so no activation claim may rest
 * on it), `script` (a site-like call, `el.play()` or `__site.go`), and `mpris`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Bidi, deserialize } from './bidi.mjs';
import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
const SERVER_LOG = process.env.SERVER_LOG || '/home/yaeji/Projects/videosync/.cache/run/server.log';
const LOCAL = process.env.LOCAL_MEDIA || 'http://127.0.0.1:8898';
const BROWSER = process.env.BROWSER || 'helium';
const POLICY = process.env.POLICY || 'no-user-gesture-required';
const LABEL = process.env.LABEL ? `-${process.env.LABEL}` : '';
const LAFTEL_E1 = process.env.LAFTEL_E1 || 'https://laftel.net/player/45462/93304';
const YT = process.env.YT || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

// --- the recorder (page world) ----------------------------------------------

const RECORDER = String.raw`(emit) => {
  if (window.__acqInstalled) return;
  window.__acqInstalled = true;
  const T = () => performance.timeOrigin + performance.now();
  const serial = new WeakMap();
  let nextSerial = 1;
  const sid = (el) => { if (!serial.has(el)) serial.set(el, nextSerial++); return serial.get(el); };
  const lastIn = {};
  const srcTag = (v) => {
    const s = v.currentSrc || v.src || '';
    return s.startsWith('blob:') ? 'blob:' + s.slice(-6) : s.slice(-24);
  };
  const snap = (v) => ({
    el: sid(v), conn: v.isConnected, src: srcTag(v), rs: v.readyState, ns: v.networkState,
    paused: v.paused, ended: v.ended, ct: +v.currentTime.toFixed(3),
    dur: Number.isFinite(v.duration) ? +v.duration.toFixed(3) : null,
    muted: v.muted, vol: v.volume, rate: v.playbackRate, drate: v.defaultPlaybackRate,
  });
  const common = () => {
    const now = T();
    const since = {};
    for (const k in lastIn) since[k] = Math.round(now - lastIn[k]);
    const ua = navigator.userActivation;
    return {
      t: now, href: location.href, vis: document.visibilityState,
      act: ua ? ua.isActive : null, sticky: ua ? ua.hasBeenActive : null, since,
      ad: !!document.querySelector('#movie_player.ad-showing'),
    };
  };
  const MEDIA = ['abort', 'emptied', 'loadstart', 'durationchange', 'loadedmetadata', 'loadeddata',
    'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'ended', 'seeking', 'seeked',
    'waiting', 'stalled', 'ratechange'];
  for (const type of MEDIA) {
    document.addEventListener(type, (e) => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      emit({ k: 'media', type, trusted: e.isTrusted, ...common(), ...snap(e.target) });
    }, true);
  }
  const lastTu = new WeakMap();
  document.addEventListener('timeupdate', (e) => {
    const v = e.target;
    if (!(v instanceof HTMLMediaElement)) return;
    const n = T();
    if (n - (lastTu.get(v) || 0) < 1000) return;
    lastTu.set(v, n);
    emit({ k: 'media', type: 'timeupdate', trusted: e.isTrusted, ...common(), ...snap(v) });
  }, true);
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'keydown', 'touchend', 'click']) {
    window.addEventListener(type, (e) => {
      const pt = e.pointerType;
      const activating = e.isTrusted && (type === 'keydown' ? e.key !== 'Escape'
        : type === 'pointerdown' ? pt === 'mouse' : type === 'pointerup' ? pt !== 'mouse'
          : type === 'mousedown' || type === 'touchend');
      if (activating) lastIn[type] = T();
      emit({ k: 'input', type, trusted: e.isTrusted, activating,
        key: type === 'keydown' ? (e.key === ' ' ? 'Space' : e.key) : undefined, pt, ...common() });
    }, true);
  }
  if (window.navigation) {
    navigation.addEventListener('navigate', (e) => emit({ k: 'nav', type: 'navigate',
      dest: e.destination.url, ntype: e.navigationType, ...common() }));
    navigation.addEventListener('currententrychange', () => emit({ k: 'nav', type: 'currententrychange', ...common() }));
  }
  for (const type of ['yt-navigate-start', 'yt-navigate-finish']) {
    document.addEventListener(type, () => emit({ k: 'nav', type, ...common() }));
  }
  window.addEventListener('popstate', () => emit({ k: 'nav', type: 'popstate', ...common() }));
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...a) {
      const r = orig.apply(this, a);
      emit({ k: 'nav', type: fn, ...common() });
      return r;
    };
  }
  const hasVideo = (n) => n.nodeType === 1 && (n.tagName === 'VIDEO' || !!n.querySelector?.('video'));
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) if (hasVideo(n)) emit({ k: 'dom', type: 'video-added', ...common() });
      for (const n of r.removedNodes) if (hasVideo(n)) emit({ k: 'dom', type: 'video-removed', ...common() });
    }
  }).observe(document, { childList: true, subtree: true });
  const prev = new Map();
  let lastCount = -1;
  setInterval(() => {
    const vids = document.querySelectorAll('video');
    if (vids.length !== lastCount) {
      lastCount = vids.length;
      emit({ k: 'count', n: vids.length, ...common() });
    }
    const now = T();
    for (const v of vids) {
      const s = sid(v);
      const p = prev.get(s);
      if (!p) {
        // On the element itself as well: once it is out of the document, its
        // events no longer pass through the document's capture phase.
        for (const type of ['pause', 'play', 'emptied']) {
          v.addEventListener(type, (e) => {
            if (!v.isConnected) emit({ k: 'media', type, direct: true, trusted: e.isTrusted, ...common(), ...snap(v) });
          });
        }
      }
      const cur = { paused: v.paused, src: srcTag(v), ended: v.ended, ct: v.currentTime, t: now };
      if (p) {
        const exp = p.ct + (p.paused ? 0 : (now - p.t) / 1000 * v.playbackRate);
        const what = [];
        if (p.paused !== cur.paused) what.push('paused');
        if (p.src !== cur.src) what.push('src');
        if (p.ended !== cur.ended) what.push('ended');
        if (Math.abs(cur.ct - exp) > 0.5 && !v.seeking) what.push('jump');
        if (what.length) emit({ k: 'poll', what, from: +p.ct.toFixed(3), ...common(), ...snap(v) });
      }
      prev.set(s, cur);
    }
  }, 10);
}`;

/** The same readings from inside the extension's isolated world (M5). */
const ISO_RECORDER = `(() => {
  if (window.__acqIso) return 'already';
  window.__acqIso = [];
  const T = () => performance.timeOrigin + performance.now();
  const ua = () => navigator.userActivation ? navigator.userActivation.isActive : null;
  for (const type of ['play', 'pause', 'seeking']) {
    document.addEventListener(type, (e) => window.__acqIso.push({ type, t: T(), act: ua() }), true);
  }
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, (e) => window.__acqIso.push({ type, t: T(), act: ua(), trusted: e.isTrusted }), true);
  }
  return 'ok';
})()`;

// --- results ------------------------------------------------------------------

function save(name, obj) {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  const f = join(HERE, 'results', `acquire-${name}${LABEL}.json`);
  writeFileSync(f, JSON.stringify(obj, null, 1));
  console.log(`wrote ${f}`);
}

const r1 = (x) => (x == null ? null : Math.round(x));

// --- the wire: videosyncd -verbose ---------------------------------------------

function logOffset() {
  try { return statSync(SERVER_LOG).size; } catch { return 0; }
}

/** Every `cmd` the server received for `room` since `offset`, and every refusal it sent. */
function wireCmds(room, offset) {
  let text = '';
  try { text = readFileSync(SERVER_LOG).subarray(offset).toString('utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes(`[${room}]`)) continue;
    let m = /\] <- (\S+) room\.Cmd \{ReqID:(\S*) Kind:(\w+) PositionMs:(-?\d+)(.*)\}/.exec(line);
    if (m) {
      out.push({ at: line.slice(11, 19), from: m[1], kind: m[3], positionMs: +m[4], rest: m[5].trim() });
      continue;
    }
    m = /\] -> (\S+) (\{"t":"error".*)$/.exec(line);
    if (m) out.push({ at: line.slice(11, 19), to: m[1], error: JSON.parse(m[2]).code });
  }
  return out;
}

// --- Chromium over CDP -----------------------------------------------------------

async function browserSession() {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  return { s: await new Session(v.webSocketDebuggerUrl).open(), version: v.Browser };
}

/**
 * A page under the recorder. `log` collects every entry with the probe's own
 * receive time; the recorder is re-installed on every new document.
 */
async function attachCdp(targetId) {
  let t = null;
  for (let i = 0; i < 50 && !t; i++) {
    t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === targetId);
    if (!t) await sleep(100);
  }
  if (!t) throw new Error(`no target ${targetId}`);
  const s = await new Session(t.webSocketDebuggerUrl).open();
  s.trackContexts();
  s.isolatedName = 'VideoSync';
  const page = { s, id: targetId, log: [], console: [] };
  s.on('Runtime.bindingCalled', (p) => {
    if (p.name !== '__acqEmit') return;
    try { page.log.push(JSON.parse(p.payload)); } catch { /* torn */ }
  });
  s.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/site |autoplay|VideoSync/i.test(text)) page.console.push({ t: Date.now(), text: text.slice(0, 200) });
  });
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  await s.send('Runtime.addBinding', { name: '__acqEmit' });
  const src = `(${RECORDER})((o) => window.__acqEmit(JSON.stringify(o)))`;
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  // The document already there did not run it.
  await s.eval(`${src}, 1`).catch(() => {});
  page.iso = (body) => s.evalIsolated(`(async () => { ${body} })()`);
  return page;
}

async function openWindow(url) {
  const { s } = await browserSession();
  const { targetId } = await s.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  s.close();
  const page = await attachCdp(targetId);
  if (url) await navigate(page, url);
  return page;
}

async function closeWindow(page) {
  try {
    const { s } = await browserSession();
    await s.send('Target.closeTarget', { targetId: page.id });
    s.close();
  } catch { /* already gone */ }
  page.s.close();
}

async function navigate(page, url, settleMs = 0) {
  const loaded = new Promise((res) => {
    const f = () => res();
    page.s.on('Page.loadEventFired', f);
    setTimeout(f, 20000);
  });
  await page.s.send('Page.navigate', { url });
  await loaded;
  if (settleMs) await sleep(settleMs);
}

/** A trusted click at the centre of `selector` (or at x,y). Returns the dispatch instant. */
async function cdpClick(page, selector = 'video') {
  const box = await page.s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!box) throw new Error(`nothing to click: ${selector}`);
  return cdpClickAt(page, box.x, box.y);
}

async function cdpClickAt(page, x, y) {
  const t = Date.now();
  await page.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return t;
}

async function cdpKey(page, key = ' ') {
  const t = Date.now();
  const k = key === ' '
    ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
    : { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key };
  await page.s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await page.s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  return t;
}

const media = (log, type) => log.filter((e) => e.k === 'media' && (!type || e.type === type));

/** The events of `log` from `t0` on, with times made relative to it: the readable form. */
function timeline(log, t0, kinds = ['media', 'input', 'nav', 'dom', 'count', 'poll']) {
  return log.filter((e) => e.t >= t0 && kinds.includes(e.k) && e.type !== 'timeupdate').map((e) => ({
    dt: r1(e.t - t0), k: e.k, type: e.type ?? (e.what ? e.what.join('+') : e.n),
    ...(e.el !== undefined ? { el: e.el, conn: e.conn, src: e.src, rs: e.rs, paused: e.paused, ended: e.ended, ct: e.ct, dur: e.dur, rate: e.rate } : {}),
    act: e.act, trusted: e.trusted, ...(e.key ? { key: e.key } : {}), ...(e.k === 'nav' ? { href: e.href.slice(-40) } : {}),
  }));
}

/**
 * The first move a page made on its own after `canplaythrough`: a `play`, or a
 * seek, with no activating input in the preceding `quietMs`. What `T_settle`
 * has to cover.
 */
function autonomousAfterReady(log, t0, quietMs = 2000) {
  const inputs = log.filter((e) => e.k === 'input' && e.activating).map((e) => e.t);
  const quiet = (t) => !inputs.some((i) => i <= t && t - i < quietMs);
  const firsts = {};
  for (const e of media(log)) {
    if (e.t < t0) continue;
    if (['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough'].includes(e.type) && firsts[e.type] == null) firsts[e.type] = e.t;
  }
  const ready = firsts.canplaythrough;
  const moves = media(log).filter((e) => e.t >= t0 && (e.type === 'play' || e.type === 'seeking') && quiet(e.t));
  return {
    loadstartMs: r1(firsts.loadstart - t0), metadataMs: r1(firsts.loadedmetadata - t0),
    canplayMs: r1(firsts.canplay - t0), canplaythroughMs: r1(ready - t0),
    moves: moves.map((e) => ({ type: e.type, ct: e.ct, rs: e.rs, act: e.act, sinceStartMs: r1(e.t - t0),
      afterCanplaythroughMs: ready == null ? null : r1(e.t - ready) })),
  };
}

// --- M6: when does a site's autoplay run? -------------------------------------------

async function M6() {
  const page = await openWindow('about:blank');
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, input: 'script (page autoplay)', runs: [] };
  for (const autoplay of ['attr', 'meta', 'canplay', 'canplaythrough']) {
    for (let k = 0; k < 3; k++) {
      page.log.length = 0;
      const t0 = Date.now();
      await navigate(page, `${LOCAL}/watch/${k + 1}?autoplay=${autoplay}`, 5000);
      const a = autonomousAfterReady(page.log, t0);
      const play = media(page.log, 'play')[0];
      out.runs.push({ autoplay, k, ...a, playedAtAll: !!play, playAct: play?.act ?? null, sticky: play?.sticky ?? null,
        refused: page.console.filter((c) => c.t >= t0).map((c) => c.text) });
      console.log(autoplay, k, JSON.stringify(a.moves.map((m) => [m.type, m.afterCanplaythroughMs])), 'ctt', a.canplaythroughMs);
    }
  }
  save('M6', out);
  await closeWindow(page);
}

// --- M1: the same element gets a new source ------------------------------------------

async function M1() {
  const page = await openWindow('about:blank');
  const out = { when: new Date().toISOString(), browser: 'helium', input: 'script (__site.go, el.play/pause)', runs: [] };
  const cases = [
    { name: 'src swap while playing', q: 'swap=src', playing: true },
    { name: 'src swap while paused', q: 'swap=src', playing: false },
    { name: 'MSE blob swap while playing', q: 'swap=src&mse=1', playing: true },
    { name: 'src swap, URL 300 ms later', q: 'swap=src&urlAfter=300', playing: true },
  ];
  for (const c of cases) {
    page.log.length = 0;
    await navigate(page, `${LOCAL}/watch/1?${c.q}`, 1500);
    await page.s.eval(`(async () => { const v = document.querySelector('video'); v.currentTime = 30;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      v.playbackRate = 1.5; ${c.playing ? 'await v.play();' : ''} return 1; })()`);
    await sleep(1000);
    const t0 = Date.now();
    await page.s.eval('__site.go(2), 1');
    await sleep(3000);
    const after = await page.s.eval(`(() => { const v = document.querySelector('video');
      return { paused: v.paused, ct: v.currentTime, rate: v.playbackRate, drate: v.defaultPlaybackRate, href: location.pathname }; })()`);
    const tl = timeline(page.log, t0);
    const pauseEvents = tl.filter((e) => e.type === 'pause').length;
    const silentPause = tl.some((e) => e.k === 'poll' && e.type.includes('paused') && e.paused);
    out.runs.push({ ...c, after, pauseEventsAfterSwap: pauseEvents, silentPauseSeen: silentPause,
      order: tl.filter((e) => e.k !== 'poll' || e.type !== 'jump').slice(0, 30) });
    console.log(c.name, JSON.stringify(after), 'pause events', pauseEvents, 'silent', silentPause,
      tl.filter((e) => e.k === 'media' || e.k === 'nav').slice(0, 12).map((e) => `${e.type}@${e.dt}`).join(' '));
  }
  save('M1', out);
  await closeWindow(page);
}

// --- M2: the element is replaced -------------------------------------------------------

async function M2() {
  const page = await openWindow('about:blank');
  const out = { when: new Date().toISOString(), browser: 'helium', input: 'script (__site.go)', runs: [] };
  for (const c of [
    { name: 'replace in one task', q: 'swap=el' },
    { name: 'remove, insert 300 ms later', q: 'swap=gap&gapMs=300' },
    { name: 'remove, insert 300 ms later, URL 600 ms later', q: 'swap=gap&gapMs=300&urlAfter=600' },
  ]) {
    page.log.length = 0;
    await navigate(page, `${LOCAL}/watch/1?${c.q}`, 1500);
    await page.s.eval(`document.querySelector('video').play().then(() => 1)`);
    await sleep(1000);
    const t0 = Date.now();
    await page.s.eval('__site.go(2), 1');
    await sleep(2500);
    const tl = timeline(page.log, t0);
    out.runs.push({ ...c,
      removedElementPaused: tl.some((e) => e.type === 'pause' && e.conn === false),
      zeroVideosSeen: tl.some((e) => e.k === 'count' && e.type === 0),
      order: tl.slice(0, 30) });
    console.log(c.name, tl.slice(0, 14).map((e) => `${e.type}${e.el ? `#${e.el}` : ''}${e.conn === false ? '(gone)' : ''}@${e.dt}`).join(' '));
  }
  save('M2', out);
  await closeWindow(page);
}

// --- M3: media keys (MPRIS) --------------------------------------------------------------

function mprisName() {
  const pid = process.env.HELIUM_PID || execFileSync('pgrep', ['-f', '^/opt/helium-browser-bin/helium --user-data-dir=/home/yaeji/Projects/videosync/.cache/helium-profile']).toString().trim().split('\n')[0];
  return `org.mpris.MediaPlayer2.chromium.instance${pid}`;
}

function mpris(name, method) {
  const t = Date.now();
  execFileSync('busctl', ['--user', 'call', name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', method]);
  return t;
}

async function M3() {
  const name = process.env.MPRIS || mprisName();
  const page = await openWindow('about:blank');
  const out = { when: new Date().toISOString(), browser: 'helium', input: 'mpris (busctl PlayPause)', mpris: name, runs: [] };
  for (const q of ['', 'ms=1']) {
    await navigate(page, `${LOCAL}/watch/1?${q}`, 1500);
    await page.iso(`return ${ISO_RECORDER}`).catch(() => null);
    // Make this the active media session, from script (no activation).
    await page.s.eval(`(async () => { const v = document.querySelector('video'); await v.play(); await new Promise((r) => setTimeout(r, 500)); v.pause(); return 1; })()`);
    await sleep(800);
    for (let k = 0; k < 4; k++) {
      page.log.length = 0;
      const before = await page.s.eval('navigator.userActivation.isActive');
      const t0 = mpris(name, 'PlayPause');
      await sleep(1200);
      const tl = timeline(page.log, t0 - 50);
      const ev = tl.find((e) => e.type === 'play' || e.type === 'pause');
      const iso = await page.iso('return window.__acqIso ? window.__acqIso.splice(0) : null').catch(() => null);
      out.runs.push({ mediaSessionHandlers: q === 'ms=1', k, activeBefore: before, event: ev?.type ?? null,
        eventAfterMs: ev ? ev.dt - 50 : null, actAtEvent: ev?.act ?? null, stickyAtEvent: page.log.find((e) => e.type === ev?.type)?.sticky ?? null,
        inputs: tl.filter((e) => e.k === 'input').map((e) => e.type),
        activeAfter: await page.s.eval('navigator.userActivation.isActive'),
        isolated: iso });
      console.log('mpris', q || 'default', k, JSON.stringify(out.runs.at(-1)));
    }
  }
  save('M3', out);
  await closeWindow(page);
}

// --- M5: can the isolated world read activation? ------------------------------------------

async function M5() {
  const page = await openWindow('about:blank');
  const out = { when: new Date().toISOString(), browser: 'helium', input: 'cdp (Input.dispatchMouseEvent)', samples: [] };
  await navigate(page, `${LOCAL}/watch/1`, 1500);
  await page.iso(`return ${ISO_RECORDER}`);
  for (let k = 0; k < 10; k++) {
    // Click somewhere inert (the heading), then read both worlds straight away and later.
    const t = await cdpClick(page, 'h1');
    for (const wait of [0, 100, 1000, 3000, 6000]) {
      if (wait) await sleep(wait - (wait > 100 ? (wait === 1000 ? 100 : wait === 3000 ? 1000 : 3000) : 0));
      const pageAct = await page.s.eval('navigator.userActivation.isActive');
      const isoAct = await page.iso('return navigator.userActivation ? navigator.userActivation.isActive : null');
      out.samples.push({ k, afterMs: Date.now() - t, pageAct, isoAct });
    }
  }
  out.isoEvents = await page.iso('return window.__acqIso.splice(0)');
  const inputs = page.log.filter((e) => e.k === 'input' && e.type === 'pointerdown');
  out.clickArrivalLagMs = inputs.map((e, i) => r1(e.t - (out.samples[i * 5]?.afterMs != null ? 0 : 0)));
  out.agree = out.samples.filter((s) => s.pageAct === s.isoAct).length;
  console.log('M5 agree', out.agree, '/', out.samples.length, JSON.stringify(out.samples.slice(0, 10)));
  save('M5', out);
  await closeWindow(page);
}

// --- Laftel ----------------------------------------------------------------------------------

async function laftelTab() {
  const list = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page' && /laftel\.net\/player\//.test(x.url));
  if (list.length) return attachCdp(list[0].id);
  return openWindow(LAFTEL_E1);
}

/** L1: a full load of an episode, fresh and as a resume. */
async function L1() {
  const page = await laftelTab();
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, input: 'none (full page load)', runs: [] };
  const url = process.env.LAFTEL_URL || LAFTEL_E1;
  for (const phase of ['as-is', 'after-watching', 'reload-again']) {
    if (phase === 'after-watching') {
      // Watch a while somewhere in the middle, so the site has progress to save.
      await page.s.eval(`(async () => { const v = document.querySelector('video'); v.currentTime = 400;
        await new Promise((r) => v.addEventListener('seeked', r, { once: true })); await v.play(); return 1; })()`);
      await sleep(20000);
      await page.s.eval(`document.querySelector('video').pause(), 1`);
      await sleep(3000);
    }
    page.log.length = 0;
    const t0 = Date.now();
    await navigate(page, url, 15000);
    const a = autonomousAfterReady(page.log, t0);
    const st = await page.s.eval(`(() => { const v = document.querySelector('video'); return v ? { ct: v.currentTime, paused: v.paused, rs: v.readyState, dur: v.duration } : null; })()`);
    out.runs.push({ phase, ...a, end: st, videos: page.log.filter((e) => e.k === 'count').map((e) => [r1(e.t - t0), e.n]),
      tl: timeline(page.log, t0).filter((e) => e.k !== 'poll' || e.type !== 'jump').slice(0, 60) });
    console.log('L1', phase, JSON.stringify(a), JSON.stringify(st));
  }
  save('L1', out);
  page.s.close();
}

/**
 * Laftel's own next-episode control: the link after the current episode in the
 * player's episode list (the player bar's buttons carry no labels). Scrolled
 * into view by script, which is not the navigation being measured.
 */
const LAFTEL_NEXT = `(() => {
  const links = [...document.querySelectorAll('a[href^="/player/"]')];
  const i = links.findIndex((a) => a.getAttribute('href') === location.pathname);
  const hit = i >= 0 ? links[i + 1] : null;
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  const r = hit.getBoundingClientRect();
  // The left edge: VideoSync's own panel sits over the rest of the list.
  return { x: r.left + Math.min(30, r.width / 4), y: r.top + r.height / 2, text: (hit.textContent || '').trim().slice(0, 30),
    href: hit.getAttribute('href'), visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight };
})()`;

/** L2: the site's own episode navigation, by a trusted click. */
async function L2() {
  const page = await laftelTab();
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, input: 'cdp click on the site control', runs: [] };
  for (let k = 0; k < (+process.env.N || 3); k++) {
    await navigate(page, LAFTEL_E1, 8000);
    await page.s.eval(`(async () => { const v = document.querySelector('video'); if (v.paused) await v.play().catch(() => {}); return 1; })()`);
    await sleep(2000);
    const next = await page.s.eval(LAFTEL_NEXT);
    await sleep(300);
    if (!next || !next.visible) {
      out.runs.push({ k, error: 'no visible next-episode control', next });
      console.log('L2: no next control', next);
      break;
    }
    page.log.length = 0;
    const t0 = await cdpClickAt(page, next.x, next.y);
    await sleep(12000);
    const tl = timeline(page.log, t0 - 20);
    const click = tl.find((e) => e.k === 'input' && e.type === 'pointerdown');
    const clickT = click ? t0 - 20 + click.dt : t0;
    const rel = (e) => (e ? r1(e.dt - (clickT - (t0 - 20))) : null);
    const firstOf = (type, pred = () => true) => tl.find((e) => e.type === type && pred(e));
    const els = [...new Set(tl.filter((e) => e.el).map((e) => e.el))];
    const playAfterLoad = tl.find((e) => e.type === 'play' && e.dt > (firstOf('loadstart')?.dt ?? 1e9));
    out.runs.push({
      k, control: next.text, clickArrivedAfterMs: click ? click.dt - 20 : null,
      pushStateMs: rel(firstOf('pushState')), entryChangeMs: rel(firstOf('currententrychange')),
      emptiedMs: rel(firstOf('emptied')), loadstartMs: rel(firstOf('loadstart')),
      metadataMs: rel(firstOf('loadedmetadata')), canplaythroughMs: rel(firstOf('canplaythrough')),
      playAfterLoadMs: rel(playAfterLoad), actAtThatPlay: playAfterLoad?.act ?? null,
      elements: els, zeroVideos: tl.some((e) => e.k === 'count' && e.type === 0),
      addedRemoved: tl.filter((e) => e.k === 'dom').map((e) => `${e.type}@${rel(e)}`),
      href: await page.s.eval('location.href'),
      tl: tl.filter((e) => e.k !== 'poll' || e.type !== 'jump').slice(0, 60),
    });
    console.log('L2', k, JSON.stringify({ ...out.runs.at(-1), tl: undefined }));
  }
  save('L2', out);
  page.s.close();
}

/** L3: let an episode end on its own. */
async function L3() {
  const page = await laftelTab();
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, input: 'none after a scripted seek', runs: [] };
  for (let k = 0; k < (+process.env.N || 2); k++) {
    await navigate(page, LAFTEL_E1, 8000);
    const dur = await page.s.eval(`(async () => { const v = document.querySelector('video'); v.currentTime = v.duration - 25;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true })); v.playbackRate = 1; await v.play().catch(() => {}); return v.duration; })()`);
    page.log.length = 0;
    const t0 = Date.now();
    await sleep(45000);
    const tl = timeline(page.log, t0);
    const pause = tl.find((e) => e.type === 'pause');
    const ended = tl.find((e) => e.type === 'ended');
    const nav = tl.find((e) => e.k === 'nav' && (e.type === 'pushState' || e.type === 'currententrychange'));
    // Position just before the URL moved: the last reading on the old element.
    const lastBefore = nav ? [...tl].reverse().find((e) => e.dt <= nav.dt && e.ct != null) : null;
    const loadstart = tl.find((e) => e.type === 'loadstart' && (!nav || e.dt >= nav.dt - 2000));
    const playAfter = loadstart ? tl.find((e) => e.type === 'play' && e.dt > loadstart.dt) : null;
    const ctt = loadstart ? tl.find((e) => e.type === 'canplaythrough' && e.dt > loadstart.dt) : null;
    out.runs.push({
      k, durationS: dur, pauseMs: pause?.dt ?? null, pauseEndedFlag: pause?.ended ?? null, endedMs: ended?.dt ?? null,
      order: tl.filter((e) => ['pause', 'ended'].includes(e.type)).map((e) => e.type),
      navMs: nav?.dt ?? null, navType: nav?.type ?? null, remainingAtNavS: lastBefore && dur ? +(dur - lastBefore.ct).toFixed(2) : null,
      nextHref: await page.s.eval('location.href'),
      nextPlayAfterCanplaythroughMs: playAfter && ctt ? playAfter.dt - ctt.dt : null,
      nextPlayAfterNavMs: playAfter && nav ? playAfter.dt - nav.dt : null,
      actAtNextPlay: playAfter?.act ?? null, rateAfter: playAfter?.rate ?? null,
      sameElement: loadstart && pause ? loadstart.el === pause.el : null,
      tl: tl.filter((e) => e.k !== 'poll' || e.type !== 'jump').filter((e) => e.type !== 'ratechange' || true).slice(0, 80),
    });
    console.log('L3', k, JSON.stringify({ ...out.runs.at(-1), tl: undefined }));
  }
  save('L3', out);
  page.s.close();
}

/** L4: long plain playback -- does anything bump an epoch that should not? */
async function L4() {
  const page = await laftelTab();
  const secs = +(process.env.SECS || 300);
  await navigate(page, LAFTEL_E1, 8000);
  await page.s.eval(`(async () => { const v = document.querySelector('video'); v.currentTime = 60; await v.play().catch(() => {}); return 1; })()`);
  page.log.length = 0;
  const t0 = Date.now();
  await sleep(secs * 1000);
  const bumps = page.log.filter((e) => (e.k === 'media' && ['emptied', 'loadstart', 'abort'].includes(e.type)) || e.k === 'dom' || (e.k === 'nav' && e.type !== 'replaceState'));
  const out = { when: new Date().toISOString(), browser: 'helium', input: 'none', seconds: secs,
    epochEvents: bumps.map((e) => ({ dt: r1(e.t - t0), type: e.type, el: e.el })),
    elements: [...new Set(page.log.filter((e) => e.el).map((e) => e.el))],
    end: await page.s.eval(`(() => { const v = document.querySelector('video'); return { ct: v.currentTime, paused: v.paused }; })()`) };
  console.log('L4', JSON.stringify(out));
  save('L4', out);
  await page.s.eval(`document.querySelector('video').pause(), 1`);
  page.s.close();
}

/** L5 (and Y5 with MATCH=youtube): input -> play latency, per kind of press. */
async function L5() {
  const yt = process.env.SITE === 'youtube';
  const page = yt ? await openWindow(YT) : await laftelTab();
  if (!yt) await navigate(page, LAFTEL_E1, 8000);
  else await sleep(8000);
  const out = { when: new Date().toISOString(), browser: 'helium', site: yt ? 'youtube' : 'laftel', input: 'cdp (trusted)', presses: [] };
  const N = +process.env.N || 10;
  const kinds = yt ? ['click', 'space', 'k'] : ['click', 'space'];
  for (const kind of kinds) {
    for (let k = 0; k < N; k++) {
      const paused = await page.s.eval(`document.querySelector('video').paused`);
      page.log.length = 0;
      const t = kind === 'click' ? await cdpClick(page, 'video') : await cdpKey(page, kind === 'space' ? ' ' : 'k');
      await sleep(1500);
      const input = page.log.find((e) => e.k === 'input' && e.activating);
      const ev = page.log.find((e) => e.k === 'media' && (e.type === (paused ? 'play' : 'pause')));
      out.presses.push({ kind, want: paused ? 'play' : 'pause', dispatchToInputMs: input ? r1(input.t - t) : null,
        inputToEventMs: input && ev ? r1(ev.t - input.t) : null, actAtEvent: ev?.act ?? null, gotIt: !!ev });
      console.log('L5', kind, k, JSON.stringify(out.presses.at(-1)));
      await sleep(300);
    }
  }
  const lat = out.presses.filter((p) => p.inputToEventMs != null).map((p) => p.inputToEventMs).sort((a, b) => a - b);
  out.summary = { n: lat.length, p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], max: lat.at(-1),
    byKind: Object.fromEntries(kinds.map((k) => [k, out.presses.filter((p) => p.kind === k && p.inputToEventMs != null).map((p) => p.inputToEventMs)])) };
  console.log('L5 summary', JSON.stringify(out.summary));
  save(yt ? 'Y5' : 'L5', out);
  if (yt) await closeWindow(page); else page.s.close();
}

// --- YouTube ---------------------------------------------------------------------------------

/** Fold VideoSync's panel away: it sits over the right-hand column of a page. */
async function foldPanel(page) {
  await page.iso(`const r = VideoSync.panelRoot(); const p = r.querySelector('.panel');
    if (p && !p.classList.contains('collapsed')) [...r.querySelectorAll('button')].find((b) => b.title === '접기')?.click();
    return 1`).catch(() => {});
}

/** Y1: click a recommendation, watch -> watch. */
async function Y1() {
  const page = await openWindow(YT);
  await sleep(8000);
  await foldPanel(page);
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, input: 'cdp click on a recommendation', runs: [] };
  for (let k = 0; k < (+process.env.N || 2); k++) {
    const pick = await page.s.eval(`(() => {
      const a = [...document.querySelectorAll('a[href*="/watch?v="]')].find((x) => {
        const r = x.getBoundingClientRect(); return r.width > 80 && r.height > 40 && r.left > window.innerWidth * 0.55 && r.top > 0 && r.bottom < window.innerHeight;
      });
      if (!a) return null; const r = a.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: a.href };
    })()`);
    if (!pick) { out.runs.push({ k, error: 'no recommendation on screen' }); console.log('Y1: none on screen'); break; }
    await foldPanel(page);
    page.log.length = 0;
    const t0 = await cdpClickAt(page, pick.x, pick.y);
    await sleep(10000);
    const tl = timeline(page.log, t0 - 20);
    const click = tl.find((e) => e.k === 'input' && e.type === 'pointerdown');
    const base = click ? click.dt : 20;
    const first = (pred) => { const e = tl.find(pred); return e ? e.dt - base : null; };
    // YouTube calls play() on the emptied element, before its loadstart.
    const ls = tl.find((e) => e.type === 'emptied' || e.type === 'loadstart');
    const play = ls ? tl.find((e) => e.type === 'play' && e.dt >= ls.dt) : null;
    const ctt = ls ? tl.find((e) => e.type === 'canplaythrough' && e.dt > ls.dt) : null;
    out.runs.push({ k, to: pick.href, clickArrivedAfterMs: click ? click.dt - 20 : null,
      ytNavStartMs: first((e) => e.type === 'yt-navigate-start'), ytNavFinishMs: first((e) => e.type === 'yt-navigate-finish'),
      pushStateMs: first((e) => e.type === 'pushState'), emptiedMs: first((e) => e.type === 'emptied'),
      loadstartMs: first((e) => e.type === 'loadstart'), canplaythroughMs: ctt ? ctt.dt - base : null,
      playMs: play ? play.dt - base : null, playAfterCanplaythroughMs: play && ctt ? play.dt - ctt.dt : null,
      actAtPlay: play?.act ?? null, adSeen: page.log.some((e) => e.ad),
      elements: [...new Set(tl.filter((e) => e.el).map((e) => e.el))], zeroVideos: tl.some((e) => e.k === 'count' && e.type === 0),
      tl: tl.filter((e) => e.k !== 'poll' || e.type !== 'jump').slice(0, 60) });
    console.log('Y1', k, JSON.stringify({ ...out.runs.at(-1), tl: undefined }));
  }
  save('Y1', out);
  await closeWindow(page);
}

/** Y2: the end of a video with autonav on. */
async function Y2() {
  const page = await openWindow(YT);
  await sleep(8000);
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, input: 'none after a scripted seek', runs: [] };
  const autonav = await page.s.eval(`document.querySelector('.ytp-autonav-toggle-button')?.getAttribute('aria-checked') ?? null`);
  out.autonav = autonav;
  const dur = await page.s.eval(`(async () => { const v = document.querySelector('video'); document.querySelector('#movie_player').seekTo(v.duration - 15, true);
    await new Promise((r) => setTimeout(r, 1500)); if (v.paused) await v.play().catch(() => {}); return v.duration; })()`);
  page.log.length = 0;
  const t0 = Date.now();
  await sleep(40000);
  const tl = timeline(page.log, t0);
  const pause = tl.find((e) => e.type === 'pause');
  const nav = tl.find((e) => e.type === 'yt-navigate-start' || e.type === 'pushState');
  const ls = nav ? tl.find((e) => e.type === 'loadstart' && e.dt > nav.dt - 1000) : null;
  const play = ls ? tl.find((e) => e.type === 'play' && e.dt > ls.dt) : null;
  out.runs.push({ durationS: dur, pauseMs: pause?.dt ?? null, pauseEndedFlag: pause?.ended ?? null,
    order: tl.filter((e) => ['pause', 'ended'].includes(e.type)).map((e) => e.type),
    navMs: nav?.dt ?? null, nextHref: await page.s.eval('location.href'), playAfterNavMs: play && nav ? play.dt - nav.dt : null,
    actAtNextPlay: play?.act ?? null, tl: tl.filter((e) => e.k !== 'poll' || e.type !== 'jump').slice(0, 80) });
  console.log('Y2', JSON.stringify({ ...out.runs.at(-1), tl: undefined }));
  save('Y2', out);
  await closeWindow(page);
}

// --- CONTROL: what today's client puts on the wire -------------------------------------------

async function joinRoom(page, room, name) {
  await page.iso(`VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, ${JSON.stringify(name)}); return 1`);
  await page.s.waitFor("VideoSync.status().state === 'joined'", { isolated: true, timeoutMs: 15000 });
}

async function leaveAll(...pages) {
  for (const p of pages) await p.iso('VideoSync.leave(); return 1').catch(() => {});
}

async function statsOf(page) {
  return page.iso('const e = VideoSync.engine(); return e ? e.stats : null').catch(() => null);
}

/**
 * One scenario of the control: A holds a room, B does something a site does,
 * and nobody presses anything. Anything B puts on the wire is C1.
 */
async function controlCase(a, b, c) {
  // A: the room, on episode 1, paused or playing at `at`.
  await navigate(a, c.aUrl ?? `${LOCAL}/watch/1`, c.aUrl ? 8000 : 1200);
  await a.iso('VideoSync.leave(); return 1').catch(() => {});
  await a.s.eval(`(async () => { const v = document.querySelector('video'); v.currentTime = ${c.at ?? 30};
    await new Promise((r) => v.addEventListener('seeked', r, { once: true })); ${c.roomPlaying ? 'await v.play();' : 'v.pause();'} return 1; })()`);
  const room = await a.iso(`return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'A')`);
  await a.s.waitFor("VideoSync.status().state === 'joined'", { isolated: true });
  await sleep(1500);
  const offset = logOffset();
  const t0 = Date.now();
  b.log.length = 0;
  await c.run(a, b, room);
  await sleep(c.waitMs ?? 6000);
  const cmds = wireCmds(room.roomId, offset);
  const bId = await b.iso('return VideoSync.engine()?.id ?? ""').catch(() => '');
  const aId = await a.iso('return VideoSync.engine()?.id ?? ""').catch(() => '');
  const res = {
    name: c.name, room: room.roomId,
    cmdsFromB: cmds.filter((x) => x.kind && x.from !== aId).map((x) => `${x.kind}@${x.positionMs}`),
    cmdsFromA: cmds.filter((x) => x.kind && x.from === aId).map((x) => `${x.kind}@${x.positionMs}`),
    errors: cmds.filter((x) => x.error).map((x) => x.error),
    bStats: await statsOf(b), aStats: await statsOf(a),
    aEnd: await a.s.eval(`(() => { const v = document.querySelector('video'); return { ct: +v.currentTime.toFixed(2), paused: v.paused, href: location.pathname }; })()`),
    bEnd: await b.s.eval(`(() => { const v = document.querySelector('video'); return v ? { ct: +v.currentTime.toFixed(2), paused: v.paused, href: location.pathname } : null; })()`).catch(() => null),
    bId, aId,
    tl: timeline(b.log, t0).filter((e) => e.k !== 'poll').slice(0, 40),
  };
  await leaveAll(a, b);
  await b.s.eval(`sessionStorage.removeItem('site'), 1`).catch(() => {});
  console.log(`CONTROL ${c.name}: B sent [${res.cmdsFromB.join(', ')}]  A sent [${res.cmdsFromA.join(', ')}] errors [${res.errors}]`);
  return res;
}

const LAFTEL_E2 = process.env.LAFTEL_E2 || 'https://laftel.net/player/45462/93295';

const CONTROL_CASES = [
  {
    // Paths A and B on the real site: B is taken to A's episode, where Laftel
    // resumes from its own history and autoplays (L1).
    name: 'L1 Laftel: follow onto an episode the site resumes and autoplays',
    aUrl: LAFTEL_E1, at: 300,
    run: async (a, b, room) => {
      await navigate(b, LAFTEL_E2, 6000);
      await b.s.eval(`(() => { const v = document.querySelector('video'); v && v.pause(); return 1; })()`);
      await b.iso(`VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'B'); return 1`);
    },
    waitMs: 16000,
  },
  {
    // Path A through the follow flow: B arrives by being taken to the room's
    // video, and that page autoplays -- as soon as it can, and 1.5 s later.
    name: 'A1 follow, site autoplays at canplay',
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/2`, 1000);
      await b.s.eval(`sessionStorage.setItem('site', JSON.stringify({ autoplay: 'canplay' })), 1`);
      await b.iso(`VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'B'); return 1`);
    },
    waitMs: 9000,
  },
  {
    name: 'A2 follow, site autoplays 1.5 s after canplaythrough',
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/2`, 1000);
      await b.s.eval(`sessionStorage.setItem('site', JSON.stringify({ autoplay: 'delay', delayMs: 1500 })), 1`);
      await b.iso(`VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'B'); return 1`);
    },
    waitMs: 10000,
  },
  {
    // Path B: the site resumes from its history once it is loaded.
    name: 'B1 follow, site resumes to 120 s and autoplays',
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/2`, 1000);
      await b.s.eval(`sessionStorage.setItem('site', JSON.stringify({ resume: 120, autoplay: 'delay', delayMs: 800 })), 1`);
      await b.iso(`VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'B'); return 1`);
    },
    waitMs: 10000,
  },
  {
    // Path D: an SPA next episode that swaps the source before the URL moves.
    name: 'D1 same element, new src, URL 400 ms later, autoplays',
    roomPlaying: true, at: 60,
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/1?swap=src&urlAfter=400&autoplay=canplay`, 1500);
      await joinRoom(b, room, 'B');
      await sleep(4000);
      await b.s.eval('__site.go(2), 1');
    },
  },
  {
    // Path E: the element leaves before its replacement arrives.
    name: 'E1 element removed, new one 300 ms later, URL 600 ms later',
    roomPlaying: true, at: 60,
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/1?swap=gap&gapMs=300&urlAfter=600`, 1500);
      await joinRoom(b, room, 'B');
      await sleep(4000);
      await b.s.eval('__site.go(2), 1');
    },
  },
  {
    // Path G: two members reach the end; B's site then routes to episode 2.
    name: 'G1 end of media, then the site routes on',
    roomPlaying: true, at: 225,
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/1?next=1&swap=src&autoplay=canplay`, 1500);
      await joinRoom(b, room, 'B');
    },
    waitMs: 22000,
  },
  {
    // The gestured control: a trusted click that must always be sent.
    name: 'P1 a trusted click on B pauses the room',
    roomPlaying: true, at: 60,
    run: async (a, b, room) => {
      await navigate(b, `${LOCAL}/watch/1`, 1500);
      // Already running with the room, so the click is a pause.
      const pos = await a.s.eval(`document.querySelector('video').currentTime`);
      await b.s.eval(`(async () => { const v = document.querySelector('video'); v.currentTime = ${pos + 1.6}; await v.play(); return 1; })()`);
      await joinRoom(b, room, 'B');
      await sleep(6000);
      await cdpClick(b, 'video');
    },
    waitMs: 4000,
  },
];

async function CONTROL() {
  const a = await openWindow(`${LOCAL}/watch/1`);
  const b = await openWindow(`${LOCAL}/watch/2`);
  await sleep(1500);
  const out = { when: new Date().toISOString(), browser: 'helium', policy: POLICY, server: SERVER,
    build: process.env.BUILD || 'unspecified', cases: [] };
  const only = process.env.CASES ? new RegExp(process.env.CASES) : null;
  for (const c of CONTROL_CASES) {
    if (only && !only.test(c.name)) continue;
    try {
      out.cases.push(await controlCase(a, b, c));
    } catch (e) {
      out.cases.push({ name: c.name, error: e.message });
      console.log(`CONTROL ${c.name}: ERROR ${e.message}`);
      await leaveAll(a, b);
    }
    save('CONTROL', out);
  }
  await closeWindow(a);
  await closeWindow(b);
}

// --- Firefox over BiDi --------------------------------------------------------------------------

async function firefox(fn) {
  const b = await Bidi.connect(+(process.env.BIDI_PORT || 9223));
  try {
    await b.send('session.subscribe', { events: ['script.message'] });
    const log = [];
    b.on('script.message', (p) => { if (p.channel === 'acq') log.push(deserialize(p.data)); });
    await b.send('script.addPreloadScript', {
      functionDeclaration: `(ch) => { (${RECORDER})((o) => ch(o)); }`,
      arguments: [{ type: 'channel', value: { channel: 'acq', ownership: 'none' } }],
    });
    const ctx = await b.newTab('about:blank');
    try {
      await fn(b, ctx, log);
    } finally {
      await b.send('browsingContext.close', { context: ctx }).catch(() => {});
    }
  } finally {
    await b.close();
  }
}

async function FF() {
  const out = { when: new Date().toISOString(), browser: 'firefox', input: 'script', runs: [] };
  await firefox(async (b, ctx, log) => {
    out.version = (await b.send('session.status')).message ?? '';
    const ev = (fn) => b.eval(ctx, fn);
    // M6
    for (const autoplay of ['attr', 'meta', 'canplay', 'canplaythrough']) {
      log.length = 0;
      const t0 = Date.now();
      await b.navigate(ctx, `${LOCAL}/watch/1?autoplay=${autoplay}`);
      await sleep(5000);
      out.runs.push({ scen: 'M6', autoplay, ...autonomousAfterReady(log, t0), ua: await ev('typeof navigator.userActivation') });
      console.log('FF M6', autoplay, JSON.stringify(out.runs.at(-1)));
    }
    // M1 / M2
    for (const [scen, q, playing] of [['M1', 'swap=src', true], ['M1', 'swap=src', false], ['M1', 'swap=src&mse=1', true],
      ['M2', 'swap=el', true], ['M2', 'swap=gap&gapMs=300', true]]) {
      await b.navigate(ctx, `${LOCAL}/watch/1?${q}`);
      await sleep(1500);
      await ev(`(async () => { const v = document.querySelector('video'); v.currentTime = 30;
        await new Promise((r) => v.addEventListener('seeked', r, { once: true })); v.playbackRate = 1.5; ${playing ? 'await v.play();' : ''} return 1; })()`);
      await sleep(1000);
      log.length = 0;
      const t0 = Date.now();
      await ev('(__site.go(2), 1)');
      await sleep(3000);
      const tl = timeline(log, t0);
      const after = await ev(`(() => { const v = document.querySelector('video'); return { paused: v.paused, ct: v.currentTime, rate: v.playbackRate }; })()`);
      out.runs.push({ scen, q, playing, after, pauseEvents: tl.filter((e) => e.type === 'pause').length,
        removedElementPaused: tl.some((e) => e.type === 'pause' && e.conn === false),
        order: tl.filter((e) => e.k !== 'poll' || e.type !== 'jump').slice(0, 30) });
      console.log('FF', scen, q, playing, JSON.stringify(after), tl.filter((e) => e.k === 'media' || e.k === 'nav').slice(0, 12).map((e) => `${e.type}${e.el ? `#${e.el}` : ''}@${e.dt}`).join(' '));
    }
    // M4: MPRIS, if Firefox exports it
    let names = '';
    try { names = execFileSync('busctl', ['--user', 'list']).toString(); } catch {}
    await b.navigate(ctx, `${LOCAL}/watch/1`);
    await sleep(1500);
    await ev(`(async () => { const v = document.querySelector('video'); await v.play(); await new Promise((r) => setTimeout(r, 500)); v.pause(); return 1; })()`);
    await sleep(800);
    try { names = execFileSync('busctl', ['--user', 'list']).toString(); } catch {}
    const ff = (/org\.mpris\.MediaPlayer2\.firefox\S*/.exec(names) || [])[0];
    out.m4 = { mpris: ff ?? null, presses: [] };
    if (ff) {
      for (let k = 0; k < 4; k++) {
        log.length = 0;
        const before = await ev('navigator.userActivation.isActive');
        const t0 = mpris(ff, 'PlayPause');
        await sleep(1200);
        const tl = timeline(log, t0 - 50);
        const e = tl.find((x) => x.type === 'play' || x.type === 'pause');
        out.m4.presses.push({ k, activeBefore: before, event: e?.type ?? null, afterMs: e ? e.dt - 50 : null, actAtEvent: e?.act ?? null,
          inputs: tl.filter((x) => x.k === 'input').map((x) => x.type), activeAfter: await ev('navigator.userActivation.isActive') });
        console.log('FF M4', JSON.stringify(out.m4.presses.at(-1)));
      }
    }
  });
  save('FF', out);
}

// --- main ------------------------------------------------------------------------------------------

const SCENARIOS = { M1, M2, M3, M5, M6, L1, L2, L3, L4, L5, Y1, Y2, CONTROL, FF };

async function main() {
  const list = (process.env.SCEN || 'M6').split(',');
  for (const name of list) {
    const fn = BROWSER === 'firefox' && name !== 'FF' ? null : SCENARIOS[name];
    if (!fn) throw new Error(`unknown scenario ${name} for ${BROWSER}`);
    console.log(`== ${name}`);
    await fn();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
