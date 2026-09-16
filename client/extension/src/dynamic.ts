/**
 * The content script, registered at run time for sites the user added.
 *
 * The manifest's `content_scripts` covers the built-in descriptors and nothing
 * else, so the install prompt names only those. A site from a user or server
 * descriptor gets the same bundled `content.js` once the user has granted its
 * host (options page -> `permissions.request`): no new code, only new pages.
 *
 * Chrome MV3: `scripting.registerContentScripts`, persisted across sessions.
 * Firefox MV2: the same API where Firefox exposes it to MV2, else
 * `contentScripts.register` -- which lives only as long as the background page
 * that called it, so the registration is redone every time the background
 * starts. Neither Firefox path has been run in a browser yet.
 */
import { buildRegistry } from '@videosync/core/providers/adoption.ts';
import { dynamicPagePatterns, grantedBy } from '@videosync/core/providers/manage.ts';

import { loadProviderState } from './storage.ts';

export { loadProviderState };

const SCRIPT_ID = 'videosync-providers';

interface FirefoxContentScripts {
  register(o: { matches: string[]; excludeMatches?: string[]; js: Array<{ file: string }>; runAt?: string; allFrames?: boolean }): Promise<{ unregister(): Promise<void> }>;
}

let firefoxHandle: { unregister(): Promise<void> } | null = null;

export async function grantedOrigins(): Promise<string[]> {
  try {
    return (await chrome.permissions.getAll()).origins ?? [];
  } catch {
    return [];
  }
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Bring the registration in line with what is stored and granted, and return
 * the pages. Calls are serialised: a storage change and a permission change
 * arriving together would otherwise both unregister and then both register
 * the same id, and the second registration fails.
 */
export function syncContentScripts(): Promise<string[]> {
  const run = chain.then(syncNow, syncNow);
  chain = run.catch(() => {});
  return run;
}

async function syncNow(): Promise<string[]> {
  const state = await loadProviderState();
  const origins = await grantedOrigins();
  const granted = grantedBy(origins);
  const patterns = dynamicPagePatterns(buildRegistry(state, granted), granted);
  // The manifest's pages already get the script; a user pattern that overlaps
  // them (`*.youtube.com`) must not inject it a second time.
  const builtin = chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches ?? []) ?? [];

  const scripting = (chrome as { scripting?: typeof chrome.scripting }).scripting;
  if (scripting?.registerContentScripts) {
    const existing = await scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
    // The worker starts often and resyncs every time; re-registering an
    // unchanged script would open a window in which a loading page misses it.
    const same = (a: readonly string[] = [], b: readonly string[] = []) =>
      a.length === b.length && a.every((x, i) => x === b[i]);
    if (existing.length === 1 && same(existing[0]!.matches, patterns) &&
        same(existing[0]!.excludeMatches, builtin)) {
      return patterns;
    }
    if (existing.length) await scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    if (patterns.length) {
      await scripting.registerContentScripts([{
        id: SCRIPT_ID,
        matches: patterns,
        ...(builtin.length ? { excludeMatches: builtin } : {}),
        js: ['content.js'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      }]);
    }
    return patterns;
  }

  const ff = (globalThis as { browser?: { contentScripts?: FirefoxContentScripts } }).browser?.contentScripts;
  if (ff) {
    await firefoxHandle?.unregister().catch(() => {});
    firefoxHandle = null;
    if (patterns.length) {
      firefoxHandle = await ff.register({
        matches: patterns, ...(builtin.length ? { excludeMatches: builtin } : {}),
        js: [{ file: 'content.js' }], runAt: 'document_idle', allFrames: false,
      });
    }
    return patterns;
  }
  throw new Error('this browser offers no way to register a content script at run time');
}
