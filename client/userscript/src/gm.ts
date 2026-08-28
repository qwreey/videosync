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

declare const GM_getValue: undefined | ((k: string, d?: string) => string | undefined);
declare const GM_setValue: undefined | ((k: string, v: string) => void);

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
