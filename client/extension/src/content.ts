/**
 * VideoSync — browser extension content script.
 *
 * The same three injected pieces the userscript provides, with different
 * answers: storage is `chrome.storage.local`, the transport and every HTTP call
 * go through the service worker, and almost nothing is unreachable — because the worker is
 * exempt from the private-address block that stops a userscript talking to a
 * server on your own machine (docs/BROWSER-FINDINGS.md §8, §9).
 *
 * That exemption is the entire reason this shim exists alongside the
 * userscript.
 */
import { start } from '@videosync/core/app/bootstrap.ts';
import type { Platform, Store } from '@videosync/core/app/bootstrap.ts';
import type { AuthResponse } from '@videosync/core/app/authfetch.ts';

import { STORE_KEYS } from '@videosync/core/providers/adoption.ts';

import { PortTransport } from './porttransport.ts';
import { providerHooks } from './providers.ts';
import type { WorkerRequest } from './relay.ts';

const PREFIX = 'videosync.';
// Every key the app reads must be listed: only these are hydrated, and a key
// that is saved but not listed is written and then never seen again -- which is
// exactly how following the room to its video first lost the session.
// (No device token among them: that lives in the worker, see tokens.ts.)
const KEYS = ['server', 'room', 'secret', 'name', 'rejoin', 'authScope', ...Object.values(STORE_KEYS)] as const;

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

/**
 * False in every shipped build. harness/browser/local-ext.mjs rewrites the
 * first string in a copy of the built bundle, so its probe build -- and only
 * that -- leaves the panel reachable from the page (see Platform.openPanel).
 */
const OPEN_PANEL = ['videosync-panel:closed'][0] === 'videosync-panel:open';

async function platform(store: Store): Promise<Platform> {
  return {
    store,
    providers: await providerHooks(store),
    openPanel: OPEN_PANEL,
    makeTransport: (serverUrl) => new PortTransport(wsUrl(serverUrl)),
    /**
     * The worker makes the call against the server the settings store holds
     * -- it takes a path from here, never a URL -- so the server this call is
     * for is written there first, and the write is waited for.
     */
    async authFetch(serverUrl, path, req) {
      if (store.load('server', '') !== serverUrl) store.save('server', serverUrl);
      await store.flush?.();
      return new Promise<AuthResponse>((res) => {
        try {
          chrome.runtime.sendMessage({ t: 'auth', server: serverUrl, path, req } satisfies WorkerRequest, (out?: AuthResponse) => {
            res(out ?? { status: 0, body: '', error: String(chrome.runtime.lastError?.message ?? 'no reply') });
          });
        } catch (e) {
          // The extension was reloaded under this tab.
          res({ status: 0, body: '', error: String(e) });
        }
      });
    },
    /** Through the worker: a tab it opens is not the popup blocker's business. */
    openTab(url) {
      try {
        void chrome.runtime.sendMessage({ t: 'openTab', url } satisfies WorkerRequest);
      } catch { /* the extension was reloaded under this tab */ }
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
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __videosyncLoaded: boolean | undefined;
}

// A site the user added with a wildcard can overlap a built-in page; the
// registration excludes those, and this is the backstop -- two copies would
// mount two panels and join the room twice. The flag lives in this
// extension's isolated world, which every injection of it shares.
if (!globalThis.__videosyncLoaded) {
  globalThis.__videosyncLoaded = true;
  void (async () => {
    const app = start(await platform(await hydrate()));
    window.VideoSync = app.api;
  })();
}
