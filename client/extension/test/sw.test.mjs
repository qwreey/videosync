/**
 * The worker's socket relay. No browser: sw.ts bundled against fake
 * `chrome` and `WebSocket` globals.
 *
 * The worker is the one context exempt from Chromium's private-network block
 * (BROWSER-FINDINGS §8, §9), so what it will open for a content script is a
 * boundary, the same one the HTTP relay draws with its path allowlist.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { load } from './bundle.mjs';

const opened = [];
let onConnect = null;

class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = String(new URL(url));
    this.readyState = 0;
    this.sent = [];
    opened.push(this);
  }
  addEventListener() {}
  send(d) { this.sent.push(d); }
  close() {}
}

function connect() {
  const posted = [];
  let onMessage = null;
  const port = {
    name: 'videosync',
    postMessage: (m) => posted.push(m),
    onMessage: { addListener: (f) => { onMessage = f; } },
    onDisconnect: { addListener() {} },
  };
  onConnect(port);
  return { posted, post: (m) => onMessage(m) };
}

const saved = {};
before(async () => {
  for (const k of ['chrome', 'WebSocket']) saved[k] = globalThis[k];
  const ev = () => ({ addListener() {} });
  globalThis.WebSocket = FakeWebSocket;
  globalThis.chrome = {
    runtime: {
      id: 'ext',
      onConnect: { addListener: (f) => { onConnect = f; } },
      onMessage: ev(),
      getManifest: () => ({}),
    },
    // Enough for the load-time resync to fail quietly.
    storage: { local: { get: async () => ({}) }, onChanged: ev() },
    permissions: { getAll: async () => ({ origins: [] }), onAdded: ev(), onRemoved: ev() },
  };
  await load('sw.ts');
  assert.ok(onConnect, 'the worker listens for ports');
});
after(() => { Object.assign(globalThis, saved); });

describe('the worker socket relay', () => {
  it('opens only <server origin>/ws, whatever else the server URL carries', () => {
    opened.length = 0;
    const c = connect();
    c.post({ t: 'open', server: 'http://127.0.0.1:8787/some/path?q=1#f' });
    assert.deepEqual(opened.map((w) => w.url), ['ws://127.0.0.1:8787/ws']);

    const s = connect();
    s.post({ t: 'open', server: 'https://sync.example.org' });
    assert.deepEqual(opened.map((w) => w.url), ['ws://127.0.0.1:8787/ws', 'wss://sync.example.org/ws']);
  });

  it('refuses a whole URL, so a content script cannot name another socket', () => {
    opened.length = 0;
    const c = connect();
    c.post({ t: 'open', url: 'ws://192.168.1.10:8123/api/websocket' });
    assert.equal(opened.length, 0, 'no socket to an arbitrary LAN path');
    assert.equal(c.posted.at(-1)?.t, 'closed');
    assert.equal(c.posted.at(-1)?.clean, false);
  });

  it('refuses a server that is not http(s)', () => {
    opened.length = 0;
    for (const server of ['ws://192.168.1.10:8123', 'javascript:alert(1)', 'file:///etc/passwd', '', 42, undefined]) {
      const c = connect();
      c.post({ t: 'open', server });
      assert.equal(c.posted.at(-1)?.t, 'closed', `refused: ${String(server)}`);
    }
    assert.equal(opened.length, 0);
  });
});
