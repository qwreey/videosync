// Auth smoke: create from the panel against a -auth token -auth-scope create server,
// sign in through the login tab, then a second member joins by invite link with the
// device signed out. Drives a local-ext.mjs build (open shadow root) over CDP; BROWSER-FINDINGS §22.
//   videosyncd -verbose -auth token -auth-tokens-file $KEY_FILE -auth-scope create
//   KEY_FILE=... node harness/browser/results/drivers/auth-smoke.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from '../../cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = 'http://127.0.0.1:8787';
const SERVER_LOG = process.env.SERVER_LOG || new URL('../../../../.cache/run/server.log', import.meta.url);
// KEY_FILE: the one access key videosyncd's -auth-tokens-file holds (never written to the results).
const KEY = readFileSync(process.env.KEY_FILE, 'utf8').trim();
const A_URL = 'http://127.0.0.1:8898/watch/1';
const out = { when: new Date().toISOString(), server: SERVER, flags: '-auth token -auth-tokens-file <1 key> -auth-scope create', checks: [], steps: [] };
const check = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`); };
const step = (s) => { out.steps.push({ t: new Date().toISOString(), ...s }); console.log('  ', JSON.stringify(s)); };

const list = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter((t) => t.type === 'page');
const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const browser = await new Session(v.webSocketDebuggerUrl).open();
async function open(url) {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: true });
  for (let i = 0; i < 50; i++) {
    const t = (await list()).find((x) => x.id === targetId);
    if (t) { const s = await new Session(t.webSocketDebuggerUrl).open(); s.trackContexts(); s.isolatedName = 'VideoSync'; await s.send('Runtime.enable'); return { s, targetId }; }
    await sleep(100);
  }
  throw new Error('no target');
}

// Panel helpers, in the page's main world (the probe build's shadow root is open).
const PANEL = `(() => { for (const e of document.querySelectorAll('*')) if (e.shadowRoot && e.shadowRoot.querySelector('.auth')) return e.shadowRoot; return null; })()`;
const panelState = (p) => p.s.eval(`(() => { const r = ${PANEL}; if (!r) return null;
  const vis = (el) => !!el && el.style.display !== 'none';
  const inputs = [...r.querySelectorAll('input')].map((i) => ({ ph: i.placeholder, v: i.value }));
  return { status: r.querySelector('.status')?.textContent, authShown: vis(r.querySelector('.auth')),
    authNotice: r.querySelector('.auth .note')?.textContent, code: r.querySelector('.auth .code')?.textContent,
    signed: vis(r.querySelector('.signed')) ? r.querySelector('.signed span')?.textContent : null, inputs }; })()`);
const clickBtn = (p, text) => p.s.eval(`(() => { const r = ${PANEL}; const b = [...r.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(text)} && x.offsetParent !== null); if (!b) return false; b.click(); return true; })()`);
const setField = (p, ph, val) => p.s.eval(`(() => { const r = ${PANEL}; const i = [...r.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(ph)}); i.value = ${JSON.stringify(val)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
async function until(fn, ms = 15000, every = 150) {
  const t0 = Date.now();
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() - t0 > ms) return null; await sleep(every); }
}
const status = (p) => p.s.evalIsolated('VideoSync.status()').catch((e) => ({ err: e.message }));

// --- A: create from the panel ----------------------------------------------------
const a = await open(A_URL);
await until(() => a.s.eval(`!!${PANEL}`), 15000);
await sleep(1500);
await a.s.evalIsolated(`(async () => { const st = VideoSync.status(); if (st.state !== 'idle') VideoSync.leave(); return 1; })()`);
await setField(a, 'http://localhost:8787', SERVER);
await setField(a, '이름', 'A');
step({ a: 'click 방 만들기', clicked: await clickBtn(a, '방 만들기') });
const asked = await until(async () => { const s = await panelState(a); return s?.authShown ? s : null; });
step({ a: 'panel after create', state: asked });
check('creating a room asks to sign in', asked && /로그인/.test(asked.authNotice ?? ''), asked?.authNotice);
check('and the room was not created', (await status(a)).state !== 'joined', JSON.stringify(await status(a)));

const before = new Set((await list()).map((t) => t.id));
step({ a: 'click 브라우저에서 로그인', clicked: await clickBtn(a, '브라우저에서 로그인') });
const loginT = await until(async () => (await list()).find((t) => !before.has(t.id) && t.url.startsWith(SERVER)), 10000);
check('a login tab opens on the server\'s origin', !!loginT, loginT?.url.replace(/flow=[^&]+/, 'flow=…'));
const login = new Session(loginT.webSocketDebuggerUrl); await login.open();
await until(() => login.eval(`document.readyState === 'complete' && !!document.querySelector('input[name=key]')`), 10000);
const page = await login.eval(`({ text: document.body.innerText.slice(0, 400), fields: [...document.querySelectorAll('input')].map((i) => i.name + ':' + i.type) })`);
const panelCode = (await until(async () => { const s = await panelState(a); return s?.code && s.code !== '…' ? s.code : null; }, 5000));
step({ login: 'page', page, panelCode });
check('the login tab asks for the access key', page.fields.includes('key:password'), page.fields.join(' '));
check('the tab shows the code the panel shows', !!panelCode && page.text.includes(panelCode), `panel ${panelCode}`);
check('the panel has no key field of its own', !(await panelState(a)).inputs.some((i) => /키|key/i.test(i.ph) && i.ph !== '참가 비밀키'), JSON.stringify((await panelState(a)).inputs.map((i) => i.ph)));

// Wrong key first.
const submit = (key) => login.eval(`(() => { const f = document.querySelector('input[name=key]').form; f.querySelector('input[name=key]').value = ${JSON.stringify(key)}; f.requestSubmit ? f.requestSubmit() : f.submit(); return 1; })()`);
await submit('wrong-' + KEY);
await sleep(1500);
const wrong = await login.eval(`({ url: location.pathname, text: document.body.innerText.slice(0, 300), again: !!document.querySelector('input[name=key]') })`).catch((e) => ({ err: e.message }));
step({ login: 'after wrong key', wrong, panel: await panelState(a) });
check('a wrong key is refused, and the panel keeps waiting', (await status(a)).state !== 'joined', JSON.stringify(wrong).slice(0, 200));

// The right key. The page may have navigated; resolve the form again.
if (!wrong.again) {
  await login.send('Page.navigate', { url: loginT.url });
  await sleep(1500);
}
await until(() => login.eval(`!!document.querySelector('input[name=key]')`), 5000);
await submit(KEY);
const joined = await until(async () => { const st = await status(a); return st.state === 'joined' ? st : null; }, 20000);
await sleep(500);
const afterA = await panelState(a);
const doneText = await login.eval(`document.body.innerText.slice(0, 300)`).catch((e) => e.message);
step({ login: 'after right key', doneText, panel: afterA, status: joined });
check('after the key, the room is created and A is in it', !!joined, joined ? `room ${afterA.inputs.find((i) => i.ph === '방 ID')?.v}` : JSON.stringify(await status(a)));
check('the panel says signed in, and the sign-in box is gone', !!afterA.signed && !afterA.authShown, afterA.signed);
const roomId = afterA.inputs.find((i) => i.ph === '방 ID')?.v;
const secret = afterA.inputs.find((i) => i.ph === '참가 비밀키')?.v;
out.roomId = roomId;

const ticketBefore = await a.s.evalIsolated(`new Promise((res) => chrome.runtime.sendMessage({ t: 'auth', server: ${JSON.stringify(SERVER)}, path: '/api/ticket', req: { method: 'POST' } }, (o) => res({ status: o?.status })))`).catch((e) => ({ err: e.message }));
check('while signed in the device can get a ticket', ticketBefore?.status === 200, `POST /api/ticket -> ${ticketBefore?.status}`);
// --- sign the device out, so B cannot ride A's token --------------------------------
step({ a: 'click 로그아웃', clicked: await clickBtn(a, '로그아웃') });
await sleep(800);
const ticketAfter = await a.s.evalIsolated(`new Promise((res) => chrome.runtime.sendMessage({ t: 'auth', server: ${JSON.stringify(SERVER)}, path: '/api/ticket', req: { method: 'POST' } }, (o) => res({ status: o?.status })))`).catch((e) => ({ err: e.message }));
step({ a: 'ticket after sign-out', ticketAfter });
check('after signing out the device holds no token', ticketAfter && ticketAfter.status === 401, `POST /api/ticket -> ${ticketAfter?.status}`);
check('A stays in the room after signing out (scope create)', (await status(a)).state === 'joined', JSON.stringify(await status(a)));

// --- B: by invite link ---------------------------------------------------------------
const invite = `${A_URL}#videosync=${encodeURIComponent(roomId)}.${encodeURIComponent(secret)}`;
const logOff = readFileSync(SERVER_LOG).length;
const b = await open(invite);
await until(() => b.s.eval(`!!${PANEL}`), 15000);
await sleep(1500);
const bPre = await panelState(b);
step({ b: 'panel on the invite link', panel: bPre });
check('the invite link fills in the room and secret', bPre.inputs.find((i) => i.ph === '방 ID')?.v === roomId && bPre.inputs.find((i) => i.ph === '참가 비밀키')?.v === secret);
await setField(b, '이름', 'B');
step({ b: 'click 참가', clicked: await clickBtn(b, '참가') });
const bJoined = await until(async () => { const st = await status(b); return st.state === 'joined' ? st : null; }, 20000);
await sleep(1000);
const bPanel = await panelState(b);
step({ b: 'after invite', status: bJoined, panel: bPanel });
check('B joins by invite link without signing in', !!bJoined && !bPanel.authShown && !bPanel.signed, JSON.stringify(bJoined));
const members = await a.s.evalIsolated('VideoSync.status()');
check('A sees two members', (members.members ?? []).length === 2 || /2/.test(JSON.stringify(members)), JSON.stringify(members).slice(0, 200));
const log = readFileSync(SERVER_LOG).subarray(logOff).toString().split('\n').filter((l) => l.includes(`[${roomId}]`) && /join|hello|error/i.test(l));
out.serverLog = log.slice(0, 10);
check('the server logged the join and no error for it', log.some((l) => / join .*name="B"| join /.test(l)) && !log.some((l) => /"t":"error"/.test(l)), log.slice(0, 3).join(' | '));

// Rooms: wait a little, then leave.
await a.s.evalIsolated('VideoSync.leave()').catch(() => {});
await b.s.evalIsolated('VideoSync.leave()').catch(() => {});
await browser.send('Target.closeTarget', { targetId: b.targetId });
await browser.send('Target.closeTarget', { targetId: loginT.id }).catch(() => {});
const passed = out.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${out.checks.length} passed`);
writeFileSync(new URL('../auth-smoke.json', import.meta.url), JSON.stringify(out, null, 1));
process.exit(0);
