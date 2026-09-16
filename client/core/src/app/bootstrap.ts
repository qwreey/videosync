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
  /** A page it was not meant for has already said the move failed. */
  warned?: boolean;
  /** The writing tab, per `readTabId`, and the origin that id belongs to. */
  tab?: string;
  origin?: string;
}

/**
 * The pending rejoin, if one is live. Whether to consume it is decided at
 * startup, not here: the store is shared by every tab in the profile, so
 * reading it proves nothing about who it was written for.
 */
function readRejoin(store: Store): Rejoin | null {
  const raw = store.load('rejoin', '');
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Rejoin;
    if (typeof r.until === 'number' && Date.now() < r.until) return r;
  } catch { /* unreadable: drop it below */ }
  store.save('rejoin', '');
  return null;
}

/** `#videosync=<room>.<secret>` -- how an invite link is shared. */
function readInviteHash(hash: string): { roomId: string; secret: string } | null {
  const m = /[#&]videosync=([^.&]+)\.([^&]+)/.exec(hash);
  if (!m || !m[1] || !m[2]) return null;
  // A truncated or hand-edited link is not worth failing to start over: this
  // runs before the panel exists, so a throw here leaves no panel and no word
  // of why, on every reload of the same URL.
  try {
    return { roomId: decodeURIComponent(m[1]), secret: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/**
 * `href` with an invite's secret taken out. `dump()` output is made to be
 * pasted into an issue, and a page reached by invite link keeps
 * `#videosync=<room>.<secret>` in its URL for as long as it is open.
 */
export function redactInvite(href: string): string {
  return href.replace(/([#&]videosync=[^.&]*\.)[^&]*/g, '$1<redacted>');
}

/**
 * What a refused join tells the user to do. Only `join_refused` is about the
 * ID or the secret; a full room was reached with both right, and sending that
 * user off to re-check them is sending them the wrong way.
 */
function refusalText(code: string | undefined): string {
  if (code === 'room_full') return `방이 가득 찼어요 — 자리가 나면 다시 참가해주세요 (${code})`;
  return `참가가 거절됐어요 (방 ID나 비밀키를 확인해주세요)${code ? ` — ${code}` : ''}`;
}

const TAB_KEY = 'videosync.tab';

/**
 * This tab's identity, as far as its origin can tell. `sessionStorage` is per
 * tab and per origin and survives a navigation, which is exactly what tells a
 * rejoin record's own tab apart from any other tab of the profile arriving on
 * the same site. It is the page's storage, so it holds a random tag and
 * nothing else; with no storage the answer is '' and nothing is decided by it.
 */
function readTabId(): string {
  try {
    const s = globalThis.sessionStorage;
    let id = s.getItem(TAB_KEY) ?? '';
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      s.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

export function start(p: Platform): App {
  const adapter = new SwappableAdapter();
  let engine: SyncEngine | null = null;
  let mediaKey = normalizeMediaKey(location.href) ?? '';
  let mediaUrl = watchUrl(location.href) ?? '';
  let roomMediaKey = '';
  let roomMediaUrl = '';
  let followTimer = 0;
  /**
   * Bumped by `cancelFollow`. A follow that has started is awaiting a store
   * write, and anything that cancels it -- leaving, the room moving again, a
   * local navigation, the connection dropping -- has to reach it there too.
   */
  let followGen = 0;
  /** A room media this member chose not to be taken to. */
  let stayedAwayFrom = '';
  /** What the media action on screen is doing for this member, if anything. */
  let mediaUi: 'follow' | 'offer' | null = null;
  /**
   * What was on screen when the connection dropped. Taken down meanwhile --
   * a command sent now is dropped by a closed socket, and a follow cannot carry
   * a session that is not joined -- and put back by the next welcome, which
   * names the same room media and so would otherwise act on nothing.
   */
  let resumeMedia: 'follow' | 'offer' | null = null;
  /** Whether the last status was 'joined', so leaving it is seen once. */
  let wasJoined = false;
  /** The rejoin record this page last wrote, exactly as written. */
  let ownRejoin = '';
  let lastStatus: EngineStatus = 'idle';
  let session: { server: string; roomId: string; secret: string; name: string } | null = null;
  let waitingOn: readonly string[] = [];
  let members: readonly MemberInfo[] = [];

  const tabId = readTabId();
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
    if (!engine) return;
    if (engine.state !== 'joined') {
      // Decided when the connection is back, against the room as it is then.
      resumeMedia = 'offer';
      return;
    }
    if (!mediaKey || mediaKey === roomMediaKey) {
      clearMediaAction();
      return;
    }
    offerMoveRoom();
  }

  function clearMediaAction(): void {
    panel.clearMediaAction();
    mediaUi = null;
  }

  function offerMoveRoom(): void {
    mediaUi = 'offer';
    if (!mediaKey) {
      // A button that cannot take the member anywhere redraws itself on every
      // press and looks broken; say where the room is instead.
      if (!followableUrl(roomMediaUrl, roomMediaKey, location.href)) {
        panel.setMediaAction(`방은 다른 영상을 보고 있어요 (방: ${roomMediaKey}) — 여기서는 열 수 없어요`);
        return;
      }
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
        // The transport drops a frame it cannot send, silently.
        if (!engine || engine.state !== 'joined') return;
        engine.setMedia(mediaKey, Math.round(adapter.readState().positionS * 1000), mediaUrl);
        clearMediaAction();
      },
    );
  }

  /**
   * Drop the rejoin record this page wrote, and only that one. The key is
   * shared by every tab in the profile: another tab's follow may be on its way
   * to its next page with a record of its own, and wiping that one leaves its
   * member arriving out of the room with no word.
   */
  function forgetRejoin(): void {
    if (ownRejoin && p.store.load('rejoin', '') === ownRejoin) p.store.save('rejoin', '');
    ownRejoin = '';
  }

  function cancelFollow(): void {
    if (followTimer) clearTimeout(followTimer);
    followTimer = 0;
    followGen++;
  }

  /** The connection is gone for now; see `resumeMedia`. */
  function suspendMedia(): void {
    if (mediaUi) resumeMedia = mediaUi;
    cancelFollow();
    clearMediaAction();
    // Gate changes are only ever broadcast, so one that happened while we were
    // away is never reported, and the welcome carries no gate state. A tag
    // kept from before would stay until some unrelated gate transition.
    waitingOn = [];
    panel.setMembers(members, engine?.id ?? '', waitingOn);
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
      clearMediaAction();
      return;
    }
    const target = followableUrl(roomMediaUrl, roomMediaKey, location.href);
    if (!target || stayedAwayFrom === roomMediaKey) {
      offerMoveRoom();
      return;
    }
    const go = async () => {
      followTimer = 0;
      const gen = followGen;
      const e = engine;
      if (!e || e.state !== 'joined' || !session) return;
      const until = Date.now() + REJOIN_TTL_MS;
      // Past this point "stay here" can no longer stop anything; leaving can.
      panel.clearMediaAction();
      panel.setStatus('방이 보는 영상으로 이동하는 중…');
      // Built from `session` as it is at each pass, not when the follow was
      // scheduled: a secret rotated meanwhile -- during the write, too -- is
      // the only one the server still accepts, so a record that changed while
      // it was being written is written again.
      for (;;) {
        const record = JSON.stringify({
          ...session, key: roomMediaKey, until, tab: tabId, origin: location.origin,
        } satisfies Rejoin);
        if (record === ownRejoin) break;
        p.store.save('rejoin', record);
        ownRejoin = record;
        // The write is what carries the session to the next page; an async
        // store that is still writing when the document unloads would drop it.
        await p.store.flush?.();
        if (gen !== followGen || engine !== e || e.state !== 'joined' || !session) {
          // Cancelled while writing. Whatever cancelled it decides what
          // happens next; a record left behind would pull a later page into
          // this room.
          forgetRejoin();
          return;
        }
      }
      location.assign(target);
    };
    mediaUi = 'follow';
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
        if (wasJoined && s !== 'joined') suspendMedia();
        wasJoined = s === 'joined';
        const prev = lastStatus;
        lastStatus = s;
        // The server closes the socket right after refusing, and the close is
        // not news: "connection lost" in place of "check the room ID or
        // secret" sends the user off to debug their network.
        if (prev === 'refused' && s === 'closed') return;
        const text: Record<EngineStatus, string> = {
          idle: '', connecting: '연결하는 중…', joining: '방에 들어가는 중…',
          joined: '연결됨', refused: refusalText(detail), closed: '연결이 끊겼어요',
        };
        if (s === 'refused') panel.setStatus(text[s], 'err');
        else panel.setStatus(detail ? `${text[s]} — ${detail}` : text[s]);
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
        const resume = resumeMedia;
        resumeMedia = null;
        if (a.mediaKey !== roomMediaKey) {
          roomMediaKey = a.mediaKey;
          followRoom();
        } else if (resume === 'follow') {
          followRoom();
        } else if (resume === 'offer') {
          if (mediaKey !== roomMediaKey) offerMoveRoom();
          else clearMediaAction();
        }
      },
      onAutoplayBlocked: () => panel.showGesturePrompt(document),
      onError: (code, msg) => {
        if (code === 'rate_limited') {
          panel.setStatus('너무 빠릅니다 — 잠시 후 다시 시도해주세요.', 'warn');
          return;
        }
        // Said by `onStatus` already, in words that tell the user what to
        // check; the server's own words, when it has any, are added to them.
        if (code === 'join_refused' || code === 'room_full') {
          if (msg) panel.setStatus(`${refusalText(code)} — ${msg}`, 'err');
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
    // A follow may already be on its way to the next page. The navigation
    // cannot be taken back, but arriving must not rejoin a room left on
    // purpose.
    forgetRejoin();
    engine?.stop();
    engine = null;
    session = null;
    members = [];
    waitingOn = [];
    roomMediaKey = '';
    roomMediaUrl = '';
    stayedAwayFrom = '';
    resumeMedia = null;
    wasJoined = false;
    lastStatus = 'idle';
    panel.setJoined(false);
    panel.setMembers([], '', []);
    clearMediaAction();
    panel.hideGesturePrompt();
  }

  // A member who navigates away or closes the tab should leave cleanly, so the
  // room does not hold the readiness gate for them until GATE_TIMEOUT.
  const onPageHide = () => { engine?.stop(); };
  window.addEventListener('pagehide', onPageHide);

  refreshStatus();

  // Arriving from `followRoom`: pick the session back up, but only on the page
  // we were sent to. A redirect to a login page joins nothing.
  //
  // Only that page consumes it. The store is shared by every tab in the
  // profile, and any other tab loading meanwhile used to take the record and
  // leave the member who followed arriving out of the room, with no word.
  // A page it was not meant for says so once and leaves it for the TTL --
  // which also lets a login redirect that comes back in time still rejoin.
  //
  // On the origin that wrote it, the tab id settles whose it is: another tab
  // there neither takes it nor warns about it. Anywhere else -- the room's
  // video on another site, a login page -- nothing can tell, and the page is
  // what decides.
  const rejoin = readRejoin(p.store);
  const otherTab = !!rejoin && !!rejoin.tab && !!tabId &&
    rejoin.origin === location.origin && rejoin.tab !== tabId;
  if (rejoin && !otherTab) {
    if (rejoin.key === mediaKey) {
      p.store.save('rejoin', '');
      panel.setFields({ roomId: rejoin.roomId, secret: rejoin.secret });
      join(rejoin.server, rejoin.roomId, rejoin.secret, rejoin.name);
    } else if (!rejoin.warned) {
      p.store.save('rejoin', JSON.stringify({ ...rejoin, warned: true }));
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
        url: redactInvite(location.href),
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
