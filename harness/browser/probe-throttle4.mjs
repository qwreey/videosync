// Tie-breaker: probe-throttle2 saw a hidden muted HLS tab stall almost
// completely; probe-throttle3 saw it play perfectly. The difference between
// them was JS load in the page (timer/Worker measurement running) and dwell
// length. Sample currentTime from the DRIVER so we can see when, if ever, it
// stalls -- and under which condition.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DWELL_MS = 90000;

async function one({ audible, withLoad }) {
  const br = await launch({ headful: true, port: 9800 + Math.floor(Math.random() * 150),
    extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
  try {
    const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
    const s = await new Session(tab.webSocketDebuggerUrl).open();
    await s.send('Runtime.enable');
    await s.waitFor('window.__ready === true');
    await s.eval('probe.loadHls()');
    await s.eval(`(() => { document.getElementById('v').muted = ${!audible}; })()`);
    await s.eval('probe.play()');
    await sleep(2500);

    const other = await newTab(br.port, 'about:blank');
    await fetch(`http://127.0.0.1:${br.port}/json/activate/${other.id}`);
    await sleep(500);

    if (withLoad) {
      // Same shape of work probe-throttle2 was doing while hidden.
      await s.eval(`(() => {
        window.__load = [];
        window.__li = setInterval(() => window.__load.push(performance.now()), 100);
        const src = 'setInterval(()=>postMessage(1), 100);';
        window.__w = new Worker(URL.createObjectURL(new Blob([src], {type:'text/javascript'})));
        window.__w.onmessage = () => {};
        return true;
      })()`);
    }

    const trace = [];
    const t0 = Date.now();
    while (Date.now() - t0 < DWELL_MS) {
      const st = await s.eval('probe.state()');
      trace.push({ wallS: +((Date.now() - t0) / 1000).toFixed(1), ct: +st.ct.toFixed(2),
                   rs: st.rs, ahead: +st.ahead.toFixed(2) });
      await sleep(5000);
    }
    s.close();
    const first = trace[0], last = trace[trace.length - 1];
    return {
      audible, withLoad,
      advancedS: +(last.ct - first.ct).toFixed(1),
      wallS: +((last.wallS - first.wallS)).toFixed(1),
      ratio: +((last.ct - first.ct) / (last.wallS - first.wallS)).toFixed(3),
      trace,
    };
  } finally { await br.close(); }
}

const out = [];
for (const audible of [true, false]) for (const withLoad of [false, true]) {
  out.push(await one({ audible, withLoad }));
}
console.log(JSON.stringify(out, null, 2));
