/**
 * Where the extension keeps its settings: `chrome.storage.local`, under one
 * prefix, shared by every tab, the options page and the worker.
 */
import type { SharedArea } from '@videosync/core/app/sharedstore.ts';
import { readState, STORE_KEYS } from '@videosync/core/providers/adoption.ts';
import type { ProviderState } from '@videosync/core/providers/adoption.ts';

export const PREFIX = 'videosync.';

/** `chrome.storage.local` as `sharedStore` takes it. */
export function chromeArea(): SharedArea {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    onChanged: (fn) => {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') fn(changes);
      });
    },
  };
}

/** The descriptor state as stored right now -- not a tab's copy of it. */
export async function loadProviderState(): Promise<ProviderState> {
  const keys = Object.values(STORE_KEYS).map((k) => PREFIX + k);
  const got = await chrome.storage.local.get(keys);
  return readState((k, fb = '') => {
    const v = got[PREFIX + k];
    return typeof v === 'string' ? v : fb;
  });
}
