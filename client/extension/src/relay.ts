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
import { serverOrigin } from '@videosync/core/app/authfetch.ts';
import type { AuthPath, AuthRequest, AuthResponse } from '@videosync/core/app/authfetch.ts';
import type { ClientFrame, ServerFrame } from '@videosync/core/engine/protocol.ts';

/**
 * `open` names a server, never a socket URL: the worker builds the URL itself
 * (`socketUrl`). It is the one context Chromium lets reach loopback and the
 * LAN, so taking a whole URL let any content-script context -- a page that
 * compromised its renderer -- talk JSON to any WebSocket there, past the
 * boundary the HTTP relay draws with its path allowlist.
 */
export type ToWorker =
  | { t: 'open'; server: string }
  | { t: 'send'; frame: ClientFrame }
  | { t: 'close' };

export type FromWorker =
  | { t: 'open.ok' }
  | { t: 'frame'; frame: ServerFrame }
  | { t: 'closed'; clean: boolean; reason: string };

/**
 * One-shot messages (`chrome.runtime.sendMessage`), for what the content
 * script and the options page cannot do themselves.
 *
 * `auth` is every HTTP call to a server -- room creation, sign-in, tickets,
 * the provider index. It names a server and a path, never a URL: the worker
 * builds the URL from the server's origin and one fixed path allowlist
 * (`isAuthPath` in authfetch.ts), and adds the device token itself. The
 * server comes from the message, not from the settings store: every
 * extension context can write that store, so reading it back protected
 * nothing, and it made one tab's call fail whenever another tab had chosen
 * another server.
 */
export type WorkerRequest =
  | { t: 'auth'; server: string; path: AuthPath; req: AuthRequest }
  | { t: 'openTab'; url: string }
  /** The granted host permissions (a content script has no `permissions` API). */
  | { t: 'providers.granted' }
  /** Re-register the content script after the user changed descriptors. */
  | { t: 'providers.sync' };

export type WorkerAuthReply = AuthResponse;

export const PORT_NAME = 'videosync';

/**
 * The sync socket of a server: `ws(s)://<origin>/ws`, or null when `server`
 * is not an http(s) URL. Everything past the origin is dropped, as
 * `new URL('/ws', server)` always did.
 */
export function socketUrl(server: unknown): string | null {
  const origin = typeof server === 'string' ? serverOrigin(server) : null;
  if (!origin) return null;
  const u = new URL('/ws', origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export interface GrantedReply { origins: string[] }
export interface SyncReply { patterns: string[]; error?: string }

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

/** `Platform.authFetch`, through the worker. */
export function authCall(server: string, path: AuthPath, req: AuthRequest): Promise<AuthResponse> {
  return ask<AuthResponse>({ t: 'auth', server, path, req }, (why) => ({ status: 0, body: '', error: why }));
}
