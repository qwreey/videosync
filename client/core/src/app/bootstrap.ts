/**
 * Everything both shims do, which is everything except how they reach the
 * server and where they keep a setting.
 *
 * The userscript and the extension differ in exactly three injected pieces:
 * storage, the transport, and how a room gets created. Every other line -- find
 * the element, name the media, mount the panel, wire the engine, decide what a
 * navigation means -- is identical, so it lives here rather than in two files
 * that would drift.
 */
import { Html5Adapter } from '../adapter/html5.ts';
import { followableUrl, normalizeMediaKey, watchUrl } from '../adapter/mediakey.ts';
import { PageWatcher } from '../adapter/resolve.ts';
import { SwappableAdapter } from '../adapter/swappable.ts';
import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../engine/engine.ts';
import type { EngineStatus } from '../engine/engine.ts';
import type { MemberInfo } from '../engine/protocol.ts';
import type { Transport } from '../engine/transport.ts';
import { Panel } from '../ui/panel.ts';

/** A place to keep the server URL and the last room. Synchronous on purpose:
 *  the panel is built from it before anything can await. */
export interface Store {
  load(key: string, fallback?: string): string;
  save(key: string, value: string): void;
  /**
   * Resolves once every `save` so far has reached durable storage. Needed only
   * before leaving the page; a store whose writes are synchronous omits it.
   */
  flush?(): Promise<void>;
}

export interface Platform {
  store: Store;
  /** How this shim reaches the server. The extension relays through its
   *  service worker; the userscript opens the socket directly. */
  makeTransport(serverUrl: string): Transport;
  /** Room creation is HTTP, and the extension cannot make that call from the
   *  page either -- so it is injected alongside the transport. */
  createRoom(serverUrl: string, mediaKey: string, mediaUrl: string): Promise<{ roomId: string; secret: string }>;
  /**
   * Why this server cannot be reached from this page, if it cannot. Returns a
   * human sentence or null. The two shims have genuinely different answers:
   * a page cannot reach a private address at all, but an extension's service
   * worker can (docs/BROWSER-FINDINGS.md §8, §9).
   */
  unreachable(serverUrl: string): string | null;
}

export interface App {
  destroy(): void;
  /** Exposed for the browser harness and the console. */
  api: VideoSyncApi;
}

export interface VideoSyncApi {
  engine(): SyncEngine | null;
  adapter: SwappableAdapter;
  mediaKey(): string;
  createRoom(serverUrl: string, name: string): Promise<{ roomId: string; secret: string }>;
  join(serverUrl: string, roomId: string, secret: string, name: string): void;
  leave(): void;
  /**
   * Everything worth knowing about this session, in one object, as JSON.
   *
   * Exists because relaying a diagnosis by hand -- read `status()`, expand it,
   * copy the fields, paste them -- is lossy and slow, and every bug this design
   * has produced in the field was one-shot. The wire trace is always recording,
   * so this can be called AFTER the thing went wrong.
   */
  dump(): string;
  status(): {
    state: string; selfId: string; seq: number; blocked: boolean;
    positionS: number; paused: boolean; readyState: number;
    expectedMs: number | null; mediaKey: string; roomMediaKey: string;
    members: number; waitingOn: readonly string[];
    stats: SyncEngine['stats'] | null;
  };
}

/** How long a member sees "moving to the room's video" before it happens. */
const FOLLOW_DELAY_MS = 1500;
/** How long a pending rejoin survives, i.e. how slow a navigation may be. */
const REJOIN_TTL_MS = 60_000;

/**
 * A session carried across a full-page navigation to the room's media. The
 * page we arrive on is a fresh document with a fresh content script, so
 * without this, following the room would also leave it.
 */
interface Rejoin {
  server: string; roomId: string; secret: string; name: string;
  /** The media we were sent to. Arriving anywhere else joins nothing. */
  key: string;
  until: number;
}

function readRejoin(store: Store): Rejoin | null {
  const raw = store.load('rejoin', '');
  if (!raw) return null;
  store.save('rejoin', '');           // one use, whatever happens next
  try {
    const r = JSON.parse(raw) as Rejoin;
    return typeof r.until === 'number' && Date.now() < r.until ? r : null;
  } catch {
    return null;
  }
}

/** `#videosync=<room>.<secret>` -- how an invite link is shared. */
function readInviteHash(hash: string): { roomId: string; secret: string } | null {
  const m = /[#&]videosync=([^.&]+)\.([^&]+)/.exec(hash);
  if (!m || !m[1] || !m[2]) return null;
  return { roomId: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]) };
}

export function start(p: Platform): App {
  const adapter = new SwappableAdapter();
  let engine: SyncEngine | null = null;
  let mediaKey = normalizeMediaKey(location.href) ?? '';
  let mediaUrl = watchUrl(location.href) ?? '';
  let roomMediaKey = '';
  let roomMediaUrl = '';
  let followTimer = 0;
  /** A room media this member chose not to be taken to. */
  let stayedAwayFrom = '';
  let session: { server: string; roomId: string; secret: string; name: string } | null = null;
  let waitingOn: readonly string[] = [];
  let members: readonly MemberInfo[] = [];

  const invite = readInviteHash(location.hash);
  const panel = new Panel(document, {
    serverUrl: p.store.load('server', ''),
    name: p.store.load('name', ''),
    roomId: invite?.roomId ?? p.store.load('room', ''),
    secret: invite?.secret ?? p.store.load('secret', ''),
  }, {
    onCreateRoom: (serverUrl, name) => { void createRoom(serverUrl, name); },
    onJoin: (serverUrl, roomId, secret, name) => { join(serverUrl, roomId, secret, name); },
    onLeave: () => { leave(); },
    onChat: (text) => engine?.chat(text),
    onRotate: () => engine?.rotateSecret(),
    onGesture: () => { void engine?.resumeAfterGesture(); },
  });

  const watcher = new PageWatcher({
    doc: document,
    win: window,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => { clearTimeout(h); },
    onChange: (el, href) => {
      const key = normalizeMediaKey(href) ?? '';
      mediaUrl = watchUrl(href) ?? '';
      const mediaChanged = key !== mediaKey;
      if (mediaChanged) {
        mediaKey = key;
        // The engine has to know before the element is retargeted, not just
        // before its next evaluation: `setTarget` fires `elementreplaced`
        // synchronously, and an engine that still believes it is on the room's
        // media puts the new video at the old one's timestamp.
        engine?.setLocalMediaKey(key, mediaUrl);
      }
      adapter.setTarget(el ? new Html5Adapter(el, 'html5') : null);
      if (mediaChanged) onMediaChanged();
      refreshStatus();
    },
  });
  watcher.start();

  /**
   * Navigating to another video does NOT move the room.
   *
   * Tempting for the next-episode case, but with no host an accidental
   * navigation by any member would drag everybody off what they are watching
   * and nobody could undo it. So it becomes a button. For the same reason a
   * LOCAL navigation never takes this member back to the room's video either:
   * they just chose to leave it.
   */
  function onMediaChanged(): void {
    cancelFollow();
    if (!engine || engine.state !== 'joined') return;
    if (!mediaKey || mediaKey === roomMediaKey) {
      panel.clearMediaAction();
      return;
    }
    offerMoveRoom();
  }

  function offerMoveRoom(): void {
    if (!mediaKey) {
      panel.setMediaAction(`방은 다른 영상을 보고 있어요 (방: ${roomMediaKey})`, '방 영상 열기', () => {
        stayedAwayFrom = '';
        followRoom(0);
      });
      return;
    }
    panel.setMediaAction(
      `이 영상은 방과 달라요 (방: ${roomMediaKey || '없음'})`,
      '이 영상으로 방 옮기기',
      () => {
        engine?.setMedia(mediaKey, Math.round(adapter.readState().positionS * 1000), mediaUrl);
        panel.clearMediaAction();
      },
    );
  }

  function cancelFollow(): void {
    if (followTimer) clearTimeout(followTimer);
    followTimer = 0;
  }

  /**
   * The room is watching something else than this page, because we just
   * joined it or because it moved: take the member there. This is what makes
   * joining by code work -- the invite link's own URL goes stale as soon as the
   * room moves on, the room's does not.
   */
  function followRoom(delayMs = FOLLOW_DELAY_MS): void {
    cancelFollow();
    if (!engine || engine.state !== 'joined' || !session) return;
    if (!roomMediaKey || roomMediaKey === mediaKey) {
      panel.clearMediaAction();
      return;
    }
    const target = followableUrl(roomMediaUrl, roomMediaKey, location.href);
    if (!target || stayedAwayFrom === roomMediaKey) {
      offerMoveRoom();
      return;
    }
    const s = session;
    const go = async () => {
      followTimer = 0;
      if (!engine || engine.state !== 'joined') return;
      const rejoin: Rejoin = { ...s, key: roomMediaKey, until: Date.now() + REJOIN_TTL_MS };
      p.store.save('rejoin', JSON.stringify(rejoin));
      panel.setStatus('방이 보는 영상으로 이동하는 중…');
      // The write is what carries the session to the next page; an async store
      // that is still writing when the document unloads would drop it.
      await p.store.flush?.();
      location.assign(target);
    };
    if (delayMs <= 0) { void go(); return; }
    panel.setMediaAction('방이 보는 영상으로 곧 이동해요', '여기 있기', () => {
      cancelFollow();
      stayedAwayFrom = roomMediaKey;
      offerMoveRoom();
    });
    followTimer = setTimeout(() => { void go(); }, delayMs) as unknown as number;
  }

  function refreshStatus(): void {
    if (!engine) {
      panel.setStatus(adapter.current
        ? '영상을 찾았어요. 방을 만들거나 참가하세요.'
        : '이 페이지에서 영상을 찾지 못했어요.');
      return;
    }
    if (!adapter.current) {
      panel.setStatus('영상을 찾지 못했어요 — 방은 나를 기다리고 있어요.', 'warn');
    }
  }

  async function createRoom(serverUrl: string, name: string): Promise<{ roomId: string; secret: string }> {
    if (!serverUrl) { panel.setStatus('서버 주소를 입력해주세요.', 'err'); throw new Error('no server'); }
    const why = p.unreachable(serverUrl);
    if (why) { panel.setStatus(why, 'err'); throw new Error(why); }
    panel.setStatus('방을 만드는 중…');
    try {
      const out = await p.createRoom(serverUrl, mediaKey, mediaUrl);
      panel.setFields(out);
      // The creator seeds the room from their own player. Only here: a joiner
      // conforms to the anchor, a creator IS the anchor.
      join(serverUrl, out.roomId, out.secret, name, true);
      return out;
    } catch (e) {
      panel.setStatus(`방을 만들지 못했어요: ${(e as Error).message}. ` +
        '서버가 켜져 있는지, 주소가 맞는지 확인해주세요.', 'err');
      throw e;
    }
  }

  function join(
    serverUrl: string, roomId: string, secret: string, name: string, adopt = false,
  ): void {
    if (!serverUrl || !roomId || !secret) {
      panel.setStatus('서버 주소, 방 ID, 비밀키가 모두 필요해요.', 'err');
      return;
    }
    const why = p.unreachable(serverUrl);
    if (why) { panel.setStatus(why, 'err'); return; }
    leave();

    let transport;
    try {
      transport = p.makeTransport(serverUrl);
    } catch (e) {
      // A URL that parses but has no usable base -- `localhost:8787`, which is
      // the likeliest thing to type into a field whose placeholder is
      // `http://localhost:8787` -- makes `new URL('/ws', ...)` throw here. The
      // throw used to escape the click handler and 참가 did nothing at all,
      // with the status line still saying whatever it said before.
      panel.setStatus(`서버 주소를 사용할 수 없어요: ${(e as Error).message}`, 'err');
      return;
    }
    p.store.save('server', serverUrl);
    p.store.save('room', roomId);
    p.store.save('secret', secret);
    p.store.save('name', name);
    session = { server: serverUrl, roomId, secret, name };

    engine = new SyncEngine({
      adapter,
      transport,
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (h) => { clearTimeout(h); },
      isHidden: () => document.hidden,
    }, {
      ...DEFAULT_ENGINE_CONFIG,
      room: roomId, secret, name: name || '익명', mediaKey, mediaUrl,
      adoptLocalStateOnJoin: adopt,
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
      onSecretRotated: (sec, by) => {
        panel.setFields({ secret: sec });
        p.store.save('secret', sec);
        if (session) session = { ...session, secret: sec };
        panel.addChat('', by === engine?.id
          ? '비밀키를 교체했어요. 예전 링크로는 아무도 들어올 수 없어요.'
          : '누군가 비밀키를 교체했어요. 새 초대 링크를 공유해주세요.', true);
      },
      onMediaMismatch: (room) => {
        // The welcome already carried the anchor, so this only confirms what
        // `onAnchor` acted on. Kept for a server that sends it first.
        if (room !== roomMediaKey) {
          roomMediaKey = room;
          followRoom();
        }
      },
      onAnchor: (a) => {
        roomMediaUrl = a.mediaUrl ?? '';
        if (a.mediaKey !== roomMediaKey) {
          roomMediaKey = a.mediaKey;
          followRoom();
        }
      },
      onAutoplayBlocked: () => panel.showGesturePrompt(document),
      onError: (code, msg) => {
        if (code === 'rate_limited') {
          panel.setStatus('너무 빠릅니다 — 잠시 후 다시 시도해주세요.', 'warn');
          return;
        }
        // bad_frame means WE sent something malformed. It is our bug, and the
        // symptom is a mechanism quietly not working, so it must be visible.
        panel.setStatus(`오류 ${code}${msg ? `: ${msg}` : ''}`, 'err');
      },
    });
    engine.start();
  }

  function leave(): void {
    cancelFollow();
    engine?.stop();
    engine = null;
    session = null;
    members = [];
    waitingOn = [];
    roomMediaKey = '';
    roomMediaUrl = '';
    stayedAwayFrom = '';
    panel.setJoined(false);
    panel.setMembers([], '', []);
    panel.clearMediaAction();
    panel.hideGesturePrompt();
  }

  // A member who navigates away or closes the tab should leave cleanly, so the
  // room does not hold the readiness gate for them until GATE_TIMEOUT.
  const onPageHide = () => { engine?.stop(); };
  window.addEventListener('pagehide', onPageHide);

  refreshStatus();

  // Arriving from `followRoom`: pick the session back up, but only on the page
  // we were sent to. A redirect to a login page joins nothing.
  const rejoin = readRejoin(p.store);
  if (rejoin) {
    if (rejoin.key === mediaKey) {
      panel.setFields({ roomId: rejoin.roomId, secret: rejoin.secret });
      join(rejoin.server, rejoin.roomId, rejoin.secret, rejoin.name);
    } else {
      panel.setStatus('방 영상으로 이동하지 못했어요. 로그인이 필요한지 확인한 뒤 다시 참가해주세요.', 'warn');
    }
  }

  const api: VideoSyncApi = {
    engine: () => engine,
    adapter,
    mediaKey: () => mediaKey,
    createRoom: (serverUrl, name) => createRoom(serverUrl, name),
    join: (serverUrl, roomId, secret, name) => { join(serverUrl, roomId, secret, name); },
    leave,
    dump() {
      const s = adapter.readState();
      return JSON.stringify({
        at: new Date().toISOString(),
        url: location.href,
        mediaKey,
        mediaUrl,
        roomMediaKey,
        roomMediaUrl,
        engine: engine ? {
          state: engine.state,
          selfId: engine.id,
          appliedSeq: engine.appliedSeq,
          autoplayBlocked: engine.blocked,
          followingRoom: engine.followingRoom,
          expectedMs: engine.expectedMs(),
          anchor: engine.currentAnchor,
          clock: {
            ready: engine.clock.ready,
            rttMs: engine.clock.rttMs,
            uncertaintyMs: engine.clock.uncertaintyMs,
            samples: engine.clock.sampleCount,
          },
          stats: engine.stats,
          members: engine.roster,
          waitingOn,
          trace: engine.trace,
        } : null,
        player: {
          adapter: adapter.current?.id ?? null,
          capabilities: adapter.capabilities,
          positionS: s.positionS, paused: s.paused, rate: s.rate,
          readyState: s.readyState, muted: s.muted,
          bufferedAheadS: s.bufferedAheadS, bufferedBehindS: s.bufferedBehindS,
        },
      }, null, 2);
    },
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

  return {
    api,
    destroy() {
      leave();
      watcher.stop();
      adapter.destroy();
      panel.destroy();
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}

declare global {
  interface Window { VideoSync?: VideoSyncApi }
}
