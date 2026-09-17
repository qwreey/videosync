/**
 * The Tampermonkey surface, behind a shim.
 *
 * `@grant` is not optional here, and not only for storage. A userscript with
 * `@grant none` is injected into the *page* context, where the site's
 * Content-Security-Policy applies to everything it does -- including opening a
 * WebSocket. YouTube and most OTT sites ship a `connect-src` that does not
 * include a self-hosted sync server, so the socket would simply be refused.
 * Granting any GM API moves the script into the userscript sandbox, which has
 * its own CSP and can reach the server. This is the single most load-bearing
 * line in the metadata block.
 */
import type { RawHttp, TokenStore } from '@videosync/core/app/authfetch.ts';
import { fetchHttp, memoryTokens } from '@videosync/core/app/authfetch.ts';

import { gmRequest } from './gmxhr.ts';
import type { GmXhr } from './gmxhr.ts';

declare const GM_getValue: undefined | ((k: string, d?: string) => string | undefined);
declare const GM_setValue: undefined | ((k: string, v: string) => void);

declare const GM_xmlhttpRequest: undefined | GmXhr;
declare const GM_openInTab: undefined | ((url: string, o?: { active?: boolean }) => unknown);

const PREFIX = 'videosync.';

export function load(key: string, fallback = ''): string {
  try {
    if (typeof GM_getValue === 'function') return GM_getValue(PREFIX + key, fallback) ?? fallback;
  } catch { /* fall through */ }
  try {
    return localStorage.getItem(PREFIX + key) ?? fallback;
  } catch {
    // A site can make localStorage throw (partitioned/blocked storage). Losing
    // a remembered server URL is not a reason to fail to load.
    return fallback;
  }
}

export function save(key: string, value: string): void {
  try {
    if (typeof GM_setValue === 'function') { GM_setValue(PREFIX + key, value); return; }
  } catch { /* fall through */ }
  try { localStorage.setItem(PREFIX + key, value); } catch { /* ignore */ }
}

/**
 * HTTP from Tampermonkey's background: no CORS, no page CSP, and not the
 * page's cookies (`anonymous`). Without the grant -- the bundle injected by a
 * test driver, which is how every browser probe has run it -- the page's own
 * `fetch`, which needs the server's CORS.
 */
export const gmHttp: RawHttp = (url, init) => {
  if (typeof GM_xmlhttpRequest !== 'function') return fetchHttp(url, init);
  return gmRequest(GM_xmlhttpRequest, url, init);
};

const TOKENS_KEY = `${PREFIX}tokens`;

/**
 * Device tokens in the script's own storage, which the page cannot read.
 * Never in `localStorage` -- that is the page's -- so without the grant they
 * live only as long as the page.
 */
export function gmTokens(): TokenStore {
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return memoryTokens();
  const get = GM_getValue;
  const set = GM_setValue;
  const all = (): Record<string, string> => {
    try {
      const o = JSON.parse(get(TOKENS_KEY, '{}') ?? '{}') as unknown;
      return typeof o === 'object' && o !== null ? o as Record<string, string> : {};
    } catch {
      return {};
    }
  };
  return {
    get: (origin) => Promise.resolve(all()[origin] ?? ''),
    set: (origin, token) => {
      const m = all();
      if (token) m[origin] = token;
      else delete m[origin];
      set(TOKENS_KEY, JSON.stringify(m));
      return Promise.resolve();
    },
  };
}

/** A login tab. `GM_openInTab` is not subject to the popup blocker. */
export function openTab(url: string): void {
  if (typeof GM_openInTab === 'function') {
    GM_openInTab(url, { active: true });
    return;
  }
  window.open(url, '_blank', 'noopener');
}
