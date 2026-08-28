// Why did probe-bgpause see Chrome pause a hidden muted tab while
// probe-detector saw it keep playing? Four conditions, one variable each.
//
// The candidate explanations are (a) "muted right now" vs (b) "never made a
// sound" vs (c) "has no audio track at all". They imply different guards, so
// the difference has to be pinned down rather than assumed.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function condition({ label, src, muteBeforePlay, muteAfterPlay }) {
  const br = await launch({ headful: true, port: 9640 + Math.floor(Math.random() * 120),
    extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
  try {
    const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
    const s = await new Session(tab.webSocketDebuggerUrl).open();
    await s.send('Runtime.enable');
    await s.waitFor('window.__ready === true');

    await s.eval(`(async () => {
      const v = document.getElementById('v');
      v.src = ${JSON.stringify(src)};
      await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
      v.muted = ${!!muteBeforePlay};
      return true;
    })()`);
    await s.eval('probe.play()');
    await sleep(3000);
    if (muteAfterPlay) { await s.eval('probe.setMuted(true)'); await sleep(500); }
    const before = await s.eval('probe.state()');

    const other = await newTab(br.port, 'about:blank');
    await fetch(`http://127.0.0.1:${br.port}/json/activate/${other.id}`);
    await sleep(700);
    const vis = await s.eval('probe.visibility()');
    await sleep(6000);
    const after = await s.eval('probe.state()');
    s.close();

    return {
      label, src, muteBeforePlay: !!muteBeforePlay, muteAfterPlay: !!muteAfterPlay,
      hidden: vis.visibilityState,
      ctBefore: +before.ct.toFixed(2), ctAfter: +after.ct.toFixed(2),
      advancedS: +(after.ct - before.ct).toFixed(2),
      pausedAfter: after.paused, mutedAfter: after.muted,
      backgroundPaused: after.paused === true,
    };
  } finally { await br.close(); }
}

const out = [];
out.push(await condition({ label: 'A muted before play (never audible)', src: '/media/test.mp4', muteBeforePlay: true }));
out.push(await condition({ label: 'B audible, then muted, then hidden', src: '/media/test.mp4', muteAfterPlay: true }));
out.push(await condition({ label: 'C no audio track at all', src: '/media/noaudio.mp4' }));
out.push(await condition({ label: 'D audible throughout', src: '/media/test.mp4' }));
console.log(JSON.stringify(out, null, 2));
