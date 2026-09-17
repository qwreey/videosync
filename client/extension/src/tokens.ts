/**
 * Device tokens, in the background's own IndexedDB.
 *
 * Not `chrome.storage.local`: content scripts can read that area, and the
 * settings store in `content.ts` depends on them being able to, so its access
 * level cannot be narrowed. Not `storage.session` either: it is emptied with
 * the browser, and a device token is meant to last weeks. An extension-origin
 * database is reachable from the background (a Chromium service worker, a
 * Firefox MV2 background page) and from nothing running on a web page's
 * origin, content scripts included.
 */
import type { TokenStore } from '@videosync/core/app/authfetch.ts';

const DB = 'videosync-auth';
const STORE = 'tokens';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('indexedDB transaction failed')); };
    // A failure at commit (QuotaExceededError, a disk error, a forced close)
    // aborts a transaction whose request already succeeded, so it fires
    // `abort` and no `error`. Without this the promise never settles and the
    // memory fallback never runs: a sign-in the server already consumed hangs.
    // After an `error` the transaction aborts too; the second reject is a no-op.
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('indexedDB transaction aborted')); };
  }));
}

export function idbTokens(): TokenStore {
  // A write that failed lives here for as long as the background does:
  // worse, never wrong. Where IndexedDB is unavailable (a private window can
  // refuse it) that is every write. It is also every write on a full disk,
  // where the read still succeeds and returns what was there before -- so a
  // held entry wins over the database, and '' marks a delete that failed
  // (forgetting a session must not bring the stored token back). A write that
  // commits drops the held entry.
  const held = new Map<string, string>();
  return {
    async get(origin) {
      const h = held.get(origin);
      if (h !== undefined) return h;
      try {
        const v = await run('readonly', (s) => s.get(origin) as IDBRequest<unknown>);
        return typeof v === 'string' ? v : '';
      } catch {
        return '';
      }
    },
    async set(origin, token) {
      try {
        await run('readwrite', (s) => (token ? s.put(token, origin) : s.delete(origin)) as IDBRequest<unknown>);
        held.delete(origin);
      } catch {
        held.set(origin, token);
      }
    },
  };
}
