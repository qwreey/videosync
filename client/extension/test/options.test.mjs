/**
 * The options page, bundled against a fake DOM and a fake `chrome`. No
 * browser: what is asserted is which elements exist and stay in the page,
 * and what ends up in storage.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { BUILTIN_SOURCES } from '../../core/src/providers/builtin.gen.ts';
import { load } from './bundle.mjs';
import { button, buttons, fakeDocument, fire, settle } from './fakedom.mjs';

const SERVER = 'https://sync.example';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const LAFTEL = BUILTIN_SOURCES.find((b) => b.file.includes('laftel')).source;
// The server's copy of a descriptor that is not a built-in when adopted, and
// is one after an extension update: same id, different bytes.
const SERVED = `${LAFTEL}\n`;

const saved = {};
for (const k of ['document', 'chrome', 'confirm']) saved[k] = globalThis[k];
after(() => { Object.assign(globalThis, saved); });

/** Load options.ts against `stored` (unprefixed keys) and a server that serves `files`. */
async function openPage(stored, files = {}) {
  const { document, app } = fakeDocument();
  const store = Object.fromEntries(Object.entries(stored).map(([k, v]) => [`videosync.${k}`, v]));
  const calls = [];
  const ev = () => ({ addListener() {} });
  globalThis.document = document;
  globalThis.confirm = () => true;
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        calls.push(msg);
        let out = { patterns: [] };
        if (msg.t === 'auth') {
          const body = files[msg.path];
          out = body === undefined ? { status: 404, body: '' } : { status: 200, body };
        }
        setTimeout(() => cb(out), 0);
      },
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (o) => { Object.assign(store, o); },
      },
      onChanged: ev(),
    },
    permissions: { getAll: async () => ({ origins: [] }), request: async () => false },
  };
  await load('options.ts');
  await settle();
  const adopted = () => JSON.parse(store['videosync.providers.adopted'] ?? '[]');
  const servers = () => JSON.parse(store['videosync.providers.servers'] ?? '{}');
  return { app, calls, adopted, servers };
}

const serverInput = (app) => [...app.walk()].find((e) => e.tagName === 'INPUT' && e.attrs.type === 'url');
const autoBox = (app) => [...app.walk()].find((e) => e.tagName === 'INPUT' && e.attrs.type === 'checkbox');

describe('the server address field', () => {
  it('leaves the 불러오기 button being pressed in the page when its change fires', async () => {
    // Pressing the button blurs the edited field, which fires `change`
    // between mousedown and mouseup. A browser clicks only an element both
    // landed on, so a button rebuilt in between never gets the click.
    const index = JSON.stringify({ providers: [] });
    const { app, calls } = await openPage({}, { '/api/providers': index });
    const pressed = button(app, '불러오기');
    const input = serverInput(app);
    input.value = SERVER;
    await fire(input, 'change');
    assert.ok(pressed.isConnected, 'the pressed button is still the one in the page');
    await fire(pressed, 'click');
    assert.ok(calls.some((m) => m.t === 'auth' && m.path === '/api/providers' && m.server === SERVER),
      'the first click loads the index');
  });

  it('leaves the auto-adopt checkbox in place, enabled for the typed server', async () => {
    const { app, servers } = await openPage({});
    const box = autoBox(app);
    assert.equal(box.disabled, true, 'precondition: no server, nothing to auto-adopt from');
    const input = serverInput(app);
    input.value = SERVER;
    await fire(input, 'change');
    assert.ok(box.isConnected, 'the checkbox being clicked is still the one in the page');
    assert.equal(box.disabled, false);
    box.checked = true;
    await fire(box, 'change');
    assert.equal(servers()[SERVER]?.autoAdopt, true);
  });

  it('still drops the old server\'s list and review when the address changes', async () => {
    const index = JSON.stringify({ providers: [
      { id: 'foo-tv', name: 'Foo', version: '1', sha256: 'a'.repeat(64), hosts: ['foo.example'] },
    ] });
    const { app } = await openPage({ server: SERVER }, { '/api/providers': index });
    assert.equal(buttons(app, '살펴보기').length, 1, 'precondition: the offer is listed');
    const input = serverInput(app);
    input.value = 'https://other.example';
    await fire(input, 'change');
    assert.equal(buttons(app, '살펴보기').length, 0, 'another server\'s offers are not shown under this one');
  });
});
