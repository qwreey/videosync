/**
 * The background's token store on the failure paths a real IndexedDB takes.
 * No browser: a fake `indexedDB` that can fail the way the spec says a commit
 * fails.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { load } from './bundle.mjs';

/**
 * A database whose every transaction lets its request succeed and then ends
 * as `ending` says. A commit-time failure (QuotaExceededError, a disk error,
 * a forced close) aborts the transaction after the request already
 * succeeded, so only `abort` fires -- no request `error`, nothing to bubble
 * to `tx.onerror`.
 */
function fakeIndexedDB(ending) {
  const data = new Map();
  let closed = 0;
  const db = {
    close() { closed++; },
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      const req = { result: undefined, error: null };
      const pending = new Map();
      const store = {
        get(k) { req.result = data.get(k); return req; },
        put(v, k) { pending.set(k, v); req.result = k; return req; },
        delete(k) { pending.set(k, undefined); return req; },
      };
      tx.objectStore = () => store;
      setTimeout(() => {
        if (ending === 'commit') {
          for (const [k, v] of pending) { if (v === undefined) data.delete(k); else data.set(k, v); }
          tx.oncomplete?.({});
        } else {
          tx.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
          tx.onabort?.({});
        }
      }, 0);
      return tx;
    },
  };
  return {
    closed: () => closed,
    open() {
      const req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => req.onsuccess?.({}), 0);
      return req;
    },
  };
}

/** Resolves with the promise's value, or with `'HUNG'` if it has not settled in `ms`. */
function within(p, ms = 500) {
  return Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r('HUNG'), ms))]);
}

describe('idbTokens', () => {
  afterEach(() => { delete globalThis.indexedDB; });

  it('stores and reads back a token when the transaction commits', async () => {
    const idb = fakeIndexedDB('commit');
    globalThis.indexedDB = idb;
    const { idbTokens } = await load('tokens.ts');
    const t = idbTokens();
    await t.set('https://s.example', 'tok');
    assert.equal(await t.get('https://s.example'), 'tok');
    assert.equal(idb.closed(), 2, 'every transaction closes its connection');
  });

  it('falls back to memory when a write aborts at commit, instead of never settling', async () => {
    // A sign-in whose token write aborts must still finish: the server has
    // already consumed the flow, so a hang here loses the sign-in for good.
    const idb = fakeIndexedDB('abort');
    globalThis.indexedDB = idb;
    const { idbTokens } = await load('tokens.ts');
    const t = idbTokens();
    const r = await within(t.set('https://s.example', 'tok'));
    assert.notEqual(r, 'HUNG', 'set() must settle when the transaction aborts');
    assert.equal(await within(t.get('https://s.example')).then((x) => x.v), 'tok',
      'the token is kept in memory for as long as the background lives');
    assert.ok(idb.closed() >= 2, 'an aborted transaction closes its connection too');
  });
});
