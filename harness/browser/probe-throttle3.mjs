// Does throttling a hidden muted tab also starve the PLAYER, not just our loop?
// MSE players append buffers from JS timers; native progressive playback is
// driven by the media pipeline. If that distinction holds, a hidden muted tab
// stalls on MSE providers no matter what our sync client does.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WATCH_MS = 45000;

const br = await launch({ headful: true, port: 9701,
  extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
const out = { chromium: br.version, watchMs: WATCH_MS, cases: [] };
try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');
  const other = await newTab(br.port, 'about:blank');

  for (const mode of ['progressive', 'hls']) {
    for (const audible of [true, false]) {
      await fetch(`http://127.0.0.1:${br.port}/json/activate/${tab.id}`);
      await sleep(400);
      await s.eval(mode === 'hls' ? 'probe.loadHls()' : 'probe.loadProgressive()');
      await s.eval(`(() => { const v = document.getElementById('v'); v.muted = ${!audible}; v.currentTime = 0; })()`);
      await s.eval('probe.play()');
      await sleep(2500);
      const before = await s.eval('probe.state()');

      await fetch(`http://127.0.0.1:${br.port}/json/activate/${other.id}`);
      const t0 = Date.now();
      await sleep(WATCH_MS);
      const wall = Date.now() - t0;
      const after = await s.eval('probe.state()');
      await fetch(`http://127.0.0.1:${br.port}/json/activate/${tab.id}`);
      await sleep(300);

      const advanced = after.ct - before.ct;
      out.cases.push({
        mode, audible, wallMs: wall,
        ctBefore: +before.ct.toFixed(2), ctAfter: +after.ct.toFixed(2),
        advancedS: +advanced.toFixed(2),
        // 1.0 means playback kept real time; near 0 means it stalled.
        playbackRatioAchieved: +(advanced / (wall / 1000)).toFixed(3),
        readyStateAfter: after.rs, pausedAfter: after.paused,
        bufferedAheadAfter: +after.ahead.toFixed(2),
      });
    }
  }
  s.close();
} finally { await br.close(); }
console.log(JSON.stringify(out, null, 2));
