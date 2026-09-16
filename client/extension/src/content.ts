/**
 * VideoSync — browser extension content script.
 *
 * The same three injected pieces the userscript provides, with different
 * answers: storage is `chrome.storage.local`, the transport relays through the
 * service worker, and almost nothing is unreachable — because the worker is
 * exempt from the private-address block that stops a userscript talking to a
 * server on your own machine (docs/BROWSER-FINDINGS.md §8, §9).
 *
 * That exemption is the entire reason this shim exists alongside the
 * userscript.
 */
import { start } from '@videosync/core/app/bootstrap.ts';
import type { Platform, Store } from '@videosync/core/app/bootstrap.ts';

import { PortTransport } from './porttransport.ts';

const PREFIX = 'videosync.';
// Every key the app reads must be listed: only these are hydrated, and a key
// that is saved but not listed is written and then never seen again -- which is
// exactly how following the room to its video first lost the session.
const KEYS = ['server', 'room', 'secret', 'name', 'rejoin'] as const;

/**
 * `chrome.storage` is async and the panel is built before anything can await,
 * so the values are hydrated once up front and written through afterwards.
 * A write that loses a race costs a remembered server URL, which is not worth
 * an await in the click handler.
 */
async function hydrate(): Promise<Store> {
  const cache = new Map<string, string>();
  try {
    const got = await chrome.storage.local.get(KEYS.map((k) => PREFIX + k));
    for (const [k, v] of Object.entries(got)) {
      if (typeof v === 'string') cache.set(k, v);
    }
  } catch { /* first run, or storage is unavailable; defaults are fine */ }
  let pending: Promise<unknown> = Promise.resolve();
  return {
    load: (key, fallback = '') => cache.get(PREFIX + key) ?? fallback,
    save: (key, value) => {
      cache.set(PREFIX + key, value);
      pending = Promise.all([pending, chrome.storage.local.set({ [PREFIX + key]: value }).catch(() => {})]);
    },
    flush: () => pending.then(() => {}),
  };
}

function wsUrl(serverUrl: string): string {
  const u = new URL('/ws', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const platform = async (): Promise<Platform> => ({
  store: await hydrate(),
  makeTransport: (serverUrl) => new PortTransport(wsUrl(serverUrl)),
  async createRoom(serverUrl, mediaKey, mediaUrl) {
    const url = new URL('/api/rooms', serverUrl).toString();
    const r = await new Promise<{ ok: boolean; status: number; body: string; error?: string }>((res) => {
      chrome.runtime.sendMessage(
        { t: 'createRoom', url, body: JSON.stringify({ mediaKey, mediaUrl }) },
        (out) => res(out ?? { ok: false, status: 0, body: '', error: String(chrome.runtime.lastError?.message) }),
      );
    });
    if (!r.ok) throw new Error(r.error ?? `서버가 ${r.status}로 거절했어요`);
    return JSON.parse(r.body) as { roomId: string; secret: string };
  },
  /**
   * Only the one case the worker cannot fix. A private address is fine here --
   * that is the whole point of the extension -- but the worker still cannot
   * reach a plaintext server from a page it has no permission for, and a bad
   * URL is worth catching before it becomes a hang.
   */
  unreachable(serverUrl) {
    try {
      const u = new URL(serverUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return '서버 주소는 http:// 나 https:// 로 시작해야 해요.';
      }
    } catch {
      return '서버 주소를 이해할 수 없어요.';
    }
    return null;
  },
});

void (async () => {
  const app = start(await platform());
  window.VideoSync = app.api;
})();
