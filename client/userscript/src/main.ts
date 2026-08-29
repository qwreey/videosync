/**
 * VideoSync — Tampermonkey shim.
 *
 * Deliberately the first shipping target: it is a real deliverable under D5 and
 * it carries none of the MV3 service-worker lifetime risk, so it validates the
 * adapter layer against a real provider at the lowest cost.
 *
 * It contains no sync logic of its own. Everything below is page plumbing:
 * find the element, name the media, mount a panel, and hand all three to the
 * engine in `@videosync/core`.
 */
import { Html5Adapter } from '@videosync/core/adapter/html5.ts';
import { normalizeMediaKey } from '@videosync/core/adapter/mediakey.ts';
import { PageWatcher } from '@videosync/core/adapter/resolve.ts';
import { SwappableAdapter } from '@videosync/core/adapter/swappable.ts';
import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '@videosync/core/engine/engine.ts';
import type { EngineStatus } from '@videosync/core/engine/engine.ts';
import type { MemberInfo } from '@videosync/core/engine/protocol.ts';
import { WebSocketTransport } from '@videosync/core/engine/transport.ts';

import { load, save } from './gm.ts';
import { Panel } from './ui.ts';

const adapter = new SwappableAdapter();
let engine: SyncEngine | null = null;
let mediaKey = normalizeMediaKey(location.href) ?? '';
let roomMediaKey = '';
let waitingOn: readonly string[] = [];
let members: readonly MemberInfo[] = [];

/** `#videosync=<room>.<secret>` — how an invite link is shared. */
function readInviteHash(): { roomId: string; secret: string } | null {
  const m = /[#&]videosync=([^.&]+)\.([^&]+)/.exec(location.hash);
  if (!m || !m[1] || !m[2]) return null;
  return { roomId: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]) };
}

const invite = readInviteHash();
const panel = new Panel(document, {
  serverUrl: load('server', 'http://localhost:8787'),
  name: load('name', ''),
  roomId: invite?.roomId ?? load('room', ''),
  secret: invite?.secret ?? load('secret', ''),
}, {
  onCreateRoom: (serverUrl, name) => { void createRoom(serverUrl, name); },
  onJoin: (serverUrl, roomId, secret, name) => { join(serverUrl, roomId, secret, name); },
  onLeave: () => { leave(); },
  onChat: (text) => engine?.chat(text),
  onRotate: () => engine?.rotateSecret(),
  onGesture: () => { void engine?.resumeAfterGesture(); },
});

// --- page plumbing ----------------------------------------------------------

const watcher = new PageWatcher({
  doc: document,
  win: window,
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (h) => { clearTimeout(h); },
  onChange: (el, href) => {
    adapter.setTarget(el ? new Html5Adapter(el, 'html5') : null);
    const key = normalizeMediaKey(href) ?? '';
    if (key !== mediaKey) {
      mediaKey = key;
      // The engine has to know before its next evaluation, or it will judge the
      // new element's position against the old video's timeline.
      engine?.setLocalMediaKey(key);
      onMediaChanged();
    }
    refreshStatus();
  },
});
watcher.start();

/**
 * Navigating to another video does NOT move the room.
 *
 * It is tempting to send a `media` command automatically -- the next-episode
 * case is the whole point of a watch party. But with no host, an accidental
 * navigation by any member would drag everybody off what they are watching,
 * and there is nobody who can undo it. So we say what happened and let a person
 * decide.
 */
function onMediaChanged(): void {
  if (!engine || engine.state !== 'joined') return;
  if (!mediaKey || mediaKey === roomMediaKey) return;
  panel.setMediaAction(`이 영상은 방과 달라요 (방: ${roomMediaKey || '없음'})`, '이 영상으로 방 옮기기', () => {
    engine?.setMedia(mediaKey, Math.round(adapter.readState().positionS * 1000));
    panel.clearMediaAction();
  });
}

function refreshStatus(): void {
  if (!engine) {
    panel.setStatus(adapter.current ? '영상을 찾았어요. 방을 만들거나 참가하세요.' : '이 페이지에서 영상을 찾지 못했어요.');
    return;
  }
  if (!adapter.current) {
    panel.setStatus('영상을 찾지 못했어요 — 방은 나를 기다리고 있어요.', 'warn');
  }
}

// --- room lifecycle ---------------------------------------------------------

/**
 * Refuse a server the browser will never let us reach, with the reason.
 *
 * Measured (docs/BROWSER-FINDINGS.md §8): from a page on a public origin, a
 * request to a loopback or private address is refused **before it is sent** --
 * any scheme, http and https and ws and wss alike -- and a plaintext server is
 * additionally unreachable from an https page. Neither failure produces a
 * useful error: the request simply never settles, which looks exactly like a
 * server that is down. Catching it here is the difference between one sentence
 * and an evening.
 */
function unreachableServer(serverUrl: string): string | null {
  let u: URL;
  try { u = new URL(serverUrl); } catch { return null; }
  const local = location.protocol === 'http:' || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1';
  const privateHost = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/.test(u.hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname);
  if (!local && privateHost) {
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

async function createRoom(serverUrl: string, name: string): Promise<void> {
  if (!serverUrl) { panel.setStatus('서버 주소를 입력해주세요.', 'err'); return; }
  const unreachable = unreachableServer(serverUrl);
  if (unreachable) { panel.setStatus(unreachable, 'err'); return; }
  panel.setStatus('방을 만드는 중…');
  try {
    const res = await fetch(new URL('/api/rooms', serverUrl).toString(), {
      method: 'POST',
      body: JSON.stringify({ mediaKey }),
    });
    if (!res.ok) throw new Error(`서버가 ${res.status}로 거절했어요`);
    const { roomId, secret } = await res.json() as { roomId: string; secret: string };
    panel.setFields({ roomId, secret });
    join(serverUrl, roomId, secret, name);
  } catch (e) {
    // A userscript reaching a self-hosted server is exactly where mixed content
    // and CSP bite, so say which one it probably is rather than "failed".
    panel.setStatus(
      `방을 만들지 못했어요: ${(e as Error).message}. 서버가 켜져 있는지, 주소가 맞는지 확인해주세요.`,
      'err',
    );
  }
}

function join(serverUrl: string, roomId: string, secret: string, name: string): void {
  if (!serverUrl || !roomId || !secret) { panel.setStatus('서버 주소, 방 ID, 비밀키가 모두 필요해요.', 'err'); return; }
  const unreachable = unreachableServer(serverUrl);
  if (unreachable) { panel.setStatus(unreachable, 'err'); return; }
  leave();
  save('server', serverUrl); save('room', roomId); save('secret', secret); save('name', name);

  engine = new SyncEngine({
    adapter,
    transport: new WebSocketTransport(wsUrl(serverUrl)),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => { clearTimeout(h); },
    isHidden: () => document.hidden,
  }, {
    ...DEFAULT_ENGINE_CONFIG,
    room: roomId, secret, name: name || '익명', mediaKey,
  }, {
    onStatus: (s: EngineStatus, detail?: string) => {
      panel.setConnection(s);
      panel.setJoined(s === 'joined');
      const text: Record<EngineStatus, string> = {
        idle: '', connecting: '연결하는 중…', joining: '방에 들어가는 중…',
        joined: '연결됨', refused: '참가가 거절됐어요 (방 ID나 비밀키를 확인해주세요)',
        closed: '연결이 끊겼어요',
      };
      panel.setStatus(detail ? `${text[s]} — ${detail}` : text[s], s === 'refused' ? 'err' : '');
      if (s === 'joined') refreshStatus();
    },
    onMembers: (m) => { members = m; panel.setMembers(m, engine?.id ?? '', waitingOn); },
    onChat: (l) => panel.addChat(l.name || l.from, l.text),
    onGate: (waiting, on) => {
      waitingOn = on;
      panel.setMembers(members, engine?.id ?? '', on);
      if (waiting) panel.setStatus('버퍼링이 끝나기를 기다리는 중…', 'warn');
      else if (engine?.state === 'joined') panel.setStatus('연결됨');
    },
    onSecretRotated: (s, by) => {
      panel.setFields({ secret: s });
      save('secret', s);
      panel.addChat('', by === engine?.id
        ? '비밀키를 교체했어요. 예전 링크로는 아무도 들어올 수 없어요.'
        : '누군가 비밀키를 교체했어요. 새 초대 링크를 공유해주세요.', true);
    },
    onMediaMismatch: (room, yours) => {
      roomMediaKey = room;
      panel.setMediaAction(`방은 다른 영상을 보고 있어요 (방: ${room} / 나: ${yours})`,
        '이 영상으로 방 옮기기', () => {
          engine?.setMedia(mediaKey, Math.round(adapter.readState().positionS * 1000));
          panel.clearMediaAction();
        });
    },
    onAnchor: (a) => {
      if (a.mediaKey !== roomMediaKey) {
        roomMediaKey = a.mediaKey;
        if (roomMediaKey && mediaKey && roomMediaKey === mediaKey) panel.clearMediaAction();
      }
    },
    onAutoplayBlocked: () => panel.showGesturePrompt(document),
    onError: (code, msg) => {
      if (code === 'rate_limited') { panel.setStatus('너무 빠릅니다 — 잠시 후 다시 시도해주세요.', 'warn'); return; }
      // bad_frame means WE sent something malformed. It is our bug, and the
      // symptom is a mechanism quietly not working, so it must be visible.
      panel.setStatus(`오류 ${code}${msg ? `: ${msg}` : ''}`, 'err');
    },
  });
  engine.start();
}

function leave(): void {
  engine?.stop();
  engine = null;
  members = [];
  waitingOn = [];
  roomMediaKey = '';
  panel.setJoined(false);
  panel.setMembers([], '', []);
  panel.clearMediaAction();
  panel.hideGesturePrompt();
}

// A member who navigates away or closes the tab should leave cleanly, so the
// room does not hold the readiness gate for them until GATE_TIMEOUT.
window.addEventListener('pagehide', () => { engine?.stop(); });

refreshStatus();

/**
 * A programmatic surface, for the browser harness and for the console.
 *
 * The panel is the product, but a UI is not a test fixture: the Risk-B probe
 * drives this instead of synthesising clicks, and it is the same code path the
 * buttons call.
 */
export interface VideoSyncApi {
  engine(): SyncEngine | null;
  adapter: SwappableAdapter;
  mediaKey(): string;
  createRoom(serverUrl: string, name: string): Promise<{ roomId: string; secret: string }>;
  join(serverUrl: string, roomId: string, secret: string, name: string): void;
  leave(): void;
  /** Everything the probe asserts on, in one snapshot. */
  status(): {
    state: string; selfId: string; seq: number; blocked: boolean;
    positionS: number; paused: boolean; readyState: number;
    expectedMs: number | null; mediaKey: string; roomMediaKey: string;
    members: number; waitingOn: readonly string[];
    stats: SyncEngine['stats'] | null;
  };
}

declare global {
  interface Window { VideoSync?: VideoSyncApi }
}

window.VideoSync = {
  engine: () => engine,
  adapter,
  mediaKey: () => mediaKey,
  async createRoom(serverUrl, name) {
    const res = await fetch(new URL('/api/rooms', serverUrl).toString(), {
      method: 'POST', body: JSON.stringify({ mediaKey }),
    });
    if (!res.ok) throw new Error(`room create failed: ${res.status}`);
    const out = await res.json() as { roomId: string; secret: string };
    panel.setFields(out);
    join(serverUrl, out.roomId, out.secret, name);
    return out;
  },
  join: (serverUrl, roomId, secret, name) => { join(serverUrl, roomId, secret, name); },
  leave,
  status() {
    const s = adapter.readState();
    return {
      state: engine?.state ?? 'idle',
      selfId: engine?.id ?? '',
      seq: engine?.appliedSeq ?? 0,
      blocked: engine?.blocked ?? false,
      positionS: s.positionS,
      paused: s.paused,
      readyState: s.readyState,
      expectedMs: engine?.expectedMs() ?? null,
      mediaKey,
      roomMediaKey,
      members: members.length,
      waitingOn,
      stats: engine?.stats ?? null,
    };
  },
};
