/**
 * The protocol spoken between the content script and the service worker.
 *
 * The split is forced, not chosen: a content script on a public-origin page
 * cannot reach a server on loopback or a private address at all, while the
 * service worker can (docs/BROWSER-FINDINGS.md §9). So the socket lives in the
 * worker.
 *
 * What crosses the port is deliberately ONLY protocol frames -- never player
 * state, never a position. The engine, the detector and the clock all stay in
 * the content script beside the `<video>`, exactly as in the userscript, so no
 * position is ever read across a hop. The hop's only cost is that it sits
 * inside the measured round trip, where min-RTT sampling already accounts for
 * it and it simply widens `uncertaintyMs` by half the hop.
 */
import type { ClientFrame, ServerFrame } from '@videosync/core/engine/protocol.ts';

export type ToWorker =
  | { t: 'open'; url: string }
  | { t: 'send'; frame: ClientFrame }
  | { t: 'close' }
  | { t: 'fetch'; url: string; body: string };

export type FromWorker =
  | { t: 'open.ok' }
  | { t: 'frame'; frame: ServerFrame }
  | { t: 'closed'; clean: boolean; reason: string }
  | { t: 'fetch.ok'; id: number; status: number; body: string }
  | { t: 'fetch.err'; id: number; error: string };

export const PORT_NAME = 'videosync';

/**
 * One-shot requests to the worker over `runtime.sendMessage`, for what the
 * content script and the options page cannot do themselves: HTTP to a server
 * on a private address (the worker is exempt, §9), reading the granted host
 * permissions (no `permissions` API in a content script), and re-registering
 * the content script after the user changed descriptors.
 */
export type WorkerRequest =
  | { t: 'createRoom'; url: string; body: string }
  /** GET under `/api/providers` of `server`, and nothing else. */
  | { t: 'providers.fetch'; server: string; path: string }
  | { t: 'providers.granted' }
  | { t: 'providers.sync' };

export interface FetchReply { ok: boolean; status: number; body: string; error?: string }
export interface GrantedReply { origins: string[] }
export interface SyncReply { patterns: string[]; error?: string }

/** The path a `providers.fetch` may ask for: the index or one file. */
export function providersPath(path: string): boolean {
  return path === '/api/providers' || /^\/api\/providers\/[a-z0-9-]{2,32}\.json$/.test(path);
}

/**
 * A `runtime.sendMessage` that resolves with the reply, or with `fallback`
 * (given the browser's reason, when it is a function) when there is none.
 */
export function ask<T>(msg: WorkerRequest, fallback: T | ((why: string) => T)): Promise<T> {
  const fail = (why: string): T => (typeof fallback === 'function' ? (fallback as (w: string) => T)(why) : fallback);
  return new Promise<T>((res) => {
    try {
      chrome.runtime.sendMessage(msg, (out: T | undefined) => {
        const err = chrome.runtime.lastError;
        res(err || out === undefined ? fail(String(err?.message ?? 'no reply')) : out);
      });
    } catch (e) {
      res(fail(String(e)));
    }
  });
}
