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
import type { AuthPath, AuthRequest, AuthResponse } from '@videosync/core/app/authfetch.ts';
import type { ClientFrame, ServerFrame } from '@videosync/core/engine/protocol.ts';

export type ToWorker =
  | { t: 'open'; url: string }
  | { t: 'send'; frame: ClientFrame }
  | { t: 'close' };

export type FromWorker =
  | { t: 'open.ok' }
  | { t: 'frame'; frame: ServerFrame }
  | { t: 'closed'; clean: boolean; reason: string };

/**
 * One-shot messages (`chrome.runtime.sendMessage`).
 *
 * `auth` names a path, never a URL: the worker builds the URL from the server
 * the settings store holds, and answers with an `AuthResponse`. `server` is
 * only compared with that, so a call cannot land on a server another tab has
 * just switched the store to.
 */
export type WorkerRequest =
  | { t: 'auth'; server: string; path: AuthPath; req: AuthRequest }
  | { t: 'openTab'; url: string }
  /** GET under `/api/providers` of `server`, and nothing else. */
  | { t: 'providers.fetch'; server: string; path: string }
  /** The granted host permissions (a content script has no `permissions` API). */
  | { t: 'providers.granted' }
  /** Re-register the content script after the user changed descriptors. */
  | { t: 'providers.sync' };

export type WorkerAuthReply = AuthResponse;

export const PORT_NAME = 'videosync';

/** The settings store's key for the server URL (`content.ts` PREFIX + 'server'). */
export const SERVER_KEY = 'videosync.server';

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
