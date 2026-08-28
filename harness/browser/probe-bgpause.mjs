// Chrome pauses a MUTED video when its tab is hidden. That is indistinguishable
// from a user pause at the DOM level -- and a sync client that broadcasts it
// would pause the entire room because one member backgrounded a muted tab.
// Pin down exactly what the client can observe.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const br = await launch({ headful: true, port: 9971,
  extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
const out = { chromium: br.version, cases: [] };
try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');
  const other = await newTab(br.port, 'about:blank');

  const activate = async (id) => { await fetch(`http://127.0.0.1:${br.port}/json/activate/${id}`); await sleep(700); };

  for (const muted of [true, false]) {
    await activate(tab.id);
    await s.eval('probe.loadHls()');
    await s.eval(`(() => { const v=document.getElementById('v'); v.muted=${muted}; v.currentTime=0; })()`);
    await s.eval('probe.play()');
    await sleep(2500);
    await s.eval('probe.events()');           // drain
    const visible = await s.eval('probe.state()');

    await activate(other.id);                  // hide
    await sleep(2500);
    const hidden = await s.eval('probe.state()');
    const evHide = await s.eval('probe.events()');

    // Does unmuting while hidden bring it back?
    let unmuteRescue = null;
    if (muted) {
      await s.eval(`(() => { document.getElementById('v').muted = false; })()`);
      await sleep(2000);
      unmuteRescue = await s.eval('probe.state()');
      await s.eval(`(() => { document.getElementById('v').muted = true; })()`);
      await sleep(1500);
    }

    await activate(tab.id);                    // show again
    await sleep(2000);
    const reshown = await s.eval('probe.state()');
    const evShow = await s.eval('probe.events()');

    out.cases.push({
      muted,
      visible: { ct: +visible.ct.toFixed(2), paused: visible.paused },
      hidden: { ct: +hidden.ct.toFixed(2), paused: hidden.paused, rs: hidden.rs, ahead: +hidden.ahead.toFixed(1) },
      eventsOnHide: evHide.map((e) => e.type),
      unmuteRescue: unmuteRescue && { ct: +unmuteRescue.ct.toFixed(2), paused: unmuteRescue.paused },
      reshown: { ct: +reshown.ct.toFixed(2), paused: reshown.paused },
      eventsOnShow: evShow.map((e) => e.type),
      resumedByItself: reshown.paused === false,
    });
  }
  s.close();
} finally { await br.close(); }
console.log(JSON.stringify(out, null, 2));
