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
 * the settings store holds, and answers with an `AuthResponse`.
 */
export type WorkerRequest =
  | { t: 'auth'; path: AuthPath; req: AuthRequest }
  | { t: 'openTab'; url: string };

export type WorkerAuthReply = AuthResponse;

export const PORT_NAME = 'videosync';

/** The settings store's key for the server URL (`content.ts` PREFIX + 'server'). */
export const SERVER_KEY = 'videosync.server';
