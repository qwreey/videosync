/**
 * VideoSync — Tampermonkey shim.
 *
 * Three injected pieces and nothing else: where a setting lives, how the socket
 * is opened, and why a given server cannot be reached. Everything else is
 * `@videosync/core/app/bootstrap.ts`, shared verbatim with the extension.
 */
import { start } from '@videosync/core/app/bootstrap.ts';
import type { Platform } from '@videosync/core/app/bootstrap.ts';
import { WebSocketTransport } from '@videosync/core/engine/transport.ts';

import { load, save } from './gm.ts';
import { unreachable } from './reach.ts';

function wsUrl(serverUrl: string): string {
  const u = new URL('/ws', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const platform: Platform = {
  store: { load, save },
  makeTransport: (serverUrl) => new WebSocketTransport(wsUrl(serverUrl)),
  async createRoom(serverUrl, mediaKey, mediaUrl) {
    const res = await fetch(new URL('/api/rooms', serverUrl).toString(), {
      method: 'POST', body: JSON.stringify({ mediaKey, mediaUrl }),
    });
    if (!res.ok) throw new Error(`서버가 ${res.status}로 거절했어요`);
    return await res.json() as { roomId: string; secret: string };
  },
  unreachable: (serverUrl) => unreachable(serverUrl, location, navigator.userAgent),
};

const app = start(platform);
window.VideoSync = app.api;
