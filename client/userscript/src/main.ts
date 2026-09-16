/**
 * VideoSync — Tampermonkey shim.
 *
 * Three injected pieces and nothing else: where a setting lives, how the socket
 * is opened, and how an HTTP call reaches the server -- plus why a given server
 * cannot be reached. Everything else is `@videosync/core/app/bootstrap.ts`,
 * shared verbatim with the extension.
 */
import { makeAuthFetch } from '@videosync/core/app/authfetch.ts';
import { start } from '@videosync/core/app/bootstrap.ts';
import type { Platform } from '@videosync/core/app/bootstrap.ts';
import { WebSocketTransport } from '@videosync/core/engine/transport.ts';

import { gmHttp, gmTokens, load, openTab, save } from './gm.ts';
import { providerHooks, registerMenu } from './providers.ts';
import { unreachable } from './reach.ts';

function wsUrl(serverUrl: string): string {
  const u = new URL('/ws', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const store = { load, save };

const platform: Platform = {
  store,
  providers: providerHooks(store),
  makeTransport: (serverUrl) => new WebSocketTransport(wsUrl(serverUrl)),
  // The device token is kept in GM storage and added by this, never handed to
  // the app (see authfetch.ts).
  authFetch: makeAuthFetch(gmHttp, gmTokens()),
  openTab,
  unreachable: (serverUrl) => unreachable(serverUrl, location, navigator.userAgent),
};

registerMenu(store);
const app = start(platform);
window.VideoSync = app.api;
