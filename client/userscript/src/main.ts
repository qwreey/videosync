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

/**
 * Why this server is unreachable from this page, if it is.
 *
 * Measured (docs/BROWSER-FINDINGS.md §8): from a page on a public origin a
 * request to a loopback or private address is refused **before it is sent** --
 * any scheme, http and https and ws and wss alike -- and a plaintext server is
 * additionally unreachable from an https page. Neither failure produces a
 * useful error: the request simply never settles, which looks exactly like a
 * server that is down. Catching it here is the difference between one sentence
 * and an evening.
 *
 * The extension does not share this limit: its service worker is exempt, which
 * is the one thing it can do that a userscript structurally cannot.
 */
function unreachable(serverUrl: string): string | null {
  let u: URL;
  try { u = new URL(serverUrl); } catch { return null; }
  const pageIsLocal = location.protocol === 'http:'
    || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const targetIsPrivate =
    /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/.test(u.hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname);
  if (!pageIsLocal && targetIsPrivate) {
    return '브라우저가 이 페이지에서 로컬/사설 주소로 나가는 요청을 아예 막아요 (스킴과 무관해요). ' +
      '서버를 공개 주소 + 실제 인증서로 두거나, 터널을 쓰거나, 확장 프로그램 쪽을 쓰세요 — ' +
      '확장의 서비스 워커는 이 제한을 받지 않아요.';
  }
  if (location.protocol === 'https:' && u.protocol === 'http:') {
    return '이 페이지는 https라서 http 서버에는 연결할 수 없어요. ' +
      '서버에 TLS를 붙이거나(-tls-cert/-tls-key), TLS를 종단하는 리버스 프록시 뒤에 두세요.';
  }
  return null;
}

function wsUrl(serverUrl: string): string {
  const u = new URL('/ws', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const platform: Platform = {
  store: { load, save },
  makeTransport: (serverUrl) => new WebSocketTransport(wsUrl(serverUrl)),
  async createRoom(serverUrl, mediaKey) {
    const res = await fetch(new URL('/api/rooms', serverUrl).toString(), {
      method: 'POST', body: JSON.stringify({ mediaKey }),
    });
    if (!res.ok) throw new Error(`서버가 ${res.status}로 거절했어요`);
    return await res.json() as { roomId: string; secret: string };
  },
  unreachable,
};

const app = start(platform);
window.VideoSync = app.api;
