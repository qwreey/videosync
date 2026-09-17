// Providers smoke: videosyncd -providers <dir with localmedia.json>. The options page lists it
// as a server offer, adopting it works, and a local-media page then keys by it. Undone at the end.
// BROWSER-FINDINGS §22. Needs a local-ext.mjs build in Helium and:
//   mkdir d && cp harness/browser/results/drivers/localmedia.json d/ && videosyncd -verbose -providers d
//   EXT_ID=<the build's id, if its worker is idle> node harness/browser/results/drivers/providers-smoke.mjs
import { Session } from '../../cdp.mjs';
import { smokeRun } from './smoke.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = 'http://127.0.0.1:8787';
const PAGE = 'http://127.0.0.1:8898/watch/1';
const run = smokeRun(new URL('../providers-smoke.json', import.meta.url), { server: SERVER, flags: '-providers <dir: localmedia.json>' });
const { out, check, step } = run;

const code = await run.main(async () => {
  async function until(fn, ms = 15000, every = 150) {
    const t0 = Date.now();
    for (;;) { const r = await fn().catch(() => null); if (r) return r; if (Date.now() - t0 > ms) return null; await sleep(every); }
  }

  const list = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const browser = await new Session(v.webSocketDebuggerUrl).open();
  const extId = (await list()).find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js') && !t.url.includes('blockjmk'))?.url.split('/')[2]
    ?? process.env.EXT_ID;
  out.extensionId = extId;
  async function open(url) {
    const { targetId } = await browser.send('Target.createTarget', { url, newWindow: true });
    const t = await until(async () => (await list()).find((x) => x.id === targetId));
    const s = await new Session(t.webSocketDebuggerUrl).open();
    s.trackContexts(); s.isolatedName = 'VideoSync'; await s.send('Runtime.enable');
    return { s, targetId };
  }

  // Page key before adopting.
  const page = await open(PAGE);
  const keyOf = async () => (await until(async () => { const st = await page.s.evalIsolated('VideoSync.status()'); return st?.mediaKey ? st : null; }))?.mediaKey;
  const key0 = await keyOf();
  step({ page: 'before', key: key0 });

  // Options page.
  // Target.createTarget on an extension page is blocked by Helium (ERR_BLOCKED_BY_CLIENT);
  // the extension opens its own page, as a user's click on "options" would.
  await page.s.evalIsolated(`new Promise((res) => chrome.runtime.sendMessage({ t: 'providers.granted' }, () => res(1)))`);
  const swT = await until(async () => (await list()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`)));
  const sw = await new Session(swT.webSocketDebuggerUrl).open();
  const before = new Set((await list()).map((t) => t.id));
  await sw.send('Runtime.evaluate', { expression: `chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }), 1` });
  const optT = await until(async () => (await list()).find((t) => !before.has(t.id) && t.type === 'page' && t.url.includes('/options.html')));
  const opt = { s: await new Session(optT.webSocketDebuggerUrl).open(), targetId: optT.id };
  await until(() => opt.s.eval(`!!document.querySelector('#app section')`));
  const text = () => opt.s.eval('document.getElementById("app").innerText');
  const clickText = (label, scope = 'document') => opt.s.eval(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  await opt.s.eval(`(() => { const i = document.querySelector('input[type=url]'); i.value = ${JSON.stringify(SERVER)}; i.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(200);
  step({ opt: 'click 불러오기', clicked: await clickText('불러오기') });
  const card = await until(async () => opt.s.eval(`(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('code')?.textContent === 'localmedia'); return c ? { text: c.innerText, tags: [...c.querySelectorAll('.tag')].map((t) => t.textContent), buttons: [...c.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`), 10000);
  step({ opt: 'offer card', card, status: await opt.s.eval('document.querySelector(".status")?.textContent') });
  check('the options page lists the server descriptor as an offer', card && card.tags.includes('새 설명'), card && card.tags.join(' | '));
  check('with its hosts and hash', card && /127\.0\.0\.1/.test(card.text) && card.tags.some((t) => t.startsWith('sha256 ab860a8d')), card?.text.replace(/\n/g, ' '));
  check('it is not in force before adopting', key0 === '127.0.0.1:/watch/1', `page key ${key0}`);

  const CARD = `[...document.querySelectorAll('.card')].find((x) => x.querySelector('code')?.textContent === 'localmedia')`;
  step({ opt: 'click 살펴보기', clicked: await clickText('살펴보기', CARD) });
  const diff = await until(async () => opt.s.eval(`(() => { const c = ${CARD}; const t = c && c.querySelector('table.diff'); return t ? { rows: t.querySelectorAll('tr').length, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`), 8000);
  step({ opt: 'review', diff, status: await opt.s.eval('document.querySelector(".status")?.textContent') });
  check('reviewing shows the difference and an apply button', diff && diff.buttons.includes('적용'), JSON.stringify(diff));
  step({ opt: 'click 적용', clicked: await clickText('적용', CARD) });
  const applied = await until(async () => { const s = await opt.s.eval('document.querySelector(".status")?.textContent'); return /적용했어요/.test(s) ? s : null; }, 8000);
  await sleep(300);
  const after = await opt.s.eval(`(() => { const c = ${CARD}; return { tags: c ? [...c.querySelectorAll('.tag')].map((t) => t.textContent) : null, app: document.getElementById('app').innerText }; })()`);
  step({ opt: 'after apply', applied, tags: after.tags });
  check('applying it succeeds', !!applied, applied);
  check('the offer now reads "in use"', after.tags && after.tags.includes('사용 중'), after.tags?.join(' | '));
  check('and it is listed among the descriptors in force, as a server one', /Local media \(test\)\s*localmedia\s*서버/.test(after.app), (after.app.match(/Local media \(test\)\s*localmedia\s*서버[^]*?(?=\n(?:사용 중지|$))/) ?? [''])[0].replace(/\n/g, ' '));

  // The page picks it up on the next load.
  await page.s.send('Page.reload');
  await sleep(2500);
  const key1 = await keyOf();
  step({ page: 'after adopt + reload', key: key1 });
  check('a local-media page now keys by the adopted descriptor', key1 === 'local:/watch/1', `page key ${key1}`);
  const dump = await page.s.evalIsolated('(() => { const d = VideoSync.dump(); return { providerNotes: d.providerNotes ?? null, providerConflict: d.providerConflict ?? null }; })()').catch((e) => ({ err: e.message }));
  step({ page: 'dump', dump });

  // A room between two such pages still works (the key is what the room compares).
  const room = await page.s.evalIsolated(`VideoSync.createRoom(${JSON.stringify(SERVER)}, 'P')`).catch((e) => ({ err: e.message }));
  const joined = await until(async () => { const st = await page.s.evalIsolated('VideoSync.status()'); return st.state === 'joined' ? st : null; }, 8000);
  check('a room created there carries the new key', joined && joined.roomMediaKey === 'local:/watch/1', joined && `room ${room.roomId} key ${joined.roomMediaKey}`);
  await page.s.evalIsolated('VideoSync.leave()').catch(() => {});

  // Undo, so the profile is as it was.
  await opt.s.send('Page.reload');
  await until(() => opt.s.eval(`!!document.querySelector('#app section')`));
  await sleep(800);
  const stopped = await opt.s.eval(`(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('code')?.textContent === 'localmedia' && [...x.querySelectorAll('button')].some((b) => b.textContent === '사용 중지')); if (!c) return false; [...c.querySelectorAll('button')].find((b) => b.textContent === '사용 중지').click(); return true; })()`);
  await sleep(800);
  step({ opt: 'click 사용 중지', stopped, status: await opt.s.eval('document.querySelector(".status")?.textContent') });
  await page.s.send('Page.reload');
  await sleep(2500);
  const key2 = await keyOf();
  check('stopping it puts the page back on the generic key', stopped && key2 === '127.0.0.1:/watch/1', `page key ${key2}`);

  await browser.send('Target.closeTarget', { targetId: opt.targetId });
  await browser.send('Target.closeTarget', { targetId: page.targetId });
});
process.exit(code);
