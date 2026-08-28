// Autoplay policy, measured under Chrome's DEFAULT rules -- the situation a
// real user is in when a remote "play" command arrives and the tab holds no
// user-gesture credit. docs/PROTOCOL.md 5 requires a typed error here.
import { launch, newTab, Session } from './cdp.mjs';
const PORT = Number(process.env.PORT || 8899);
const br = await launch(); // no autoplay flag: default policy
const out = { chromium: br.version };
try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');
  await s.eval('probe.loadProgressive()');

  out.unmutedNoGesture = await s.eval('probe.play()');
  out.mutedNoGesture = await s.eval('(async () => { const v = document.getElementById("v"); v.muted = true; return probe.play(); })()');
  out.afterMuted = await s.eval('probe.state()');
  // Does unmuting after a muted autoplay keep it playing?
  out.unmuteWhilePlaying = await s.eval(
    '(async () => { const v = document.getElementById("v"); v.muted = false; await new Promise(r => setTimeout(r, 700)); return { paused: v.paused, ct: v.currentTime, muted: v.muted }; })()');
  s.close();
} finally { await br.close(); }
console.log(JSON.stringify(out, null, 2));
