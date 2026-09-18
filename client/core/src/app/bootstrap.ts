/**
 * Everything both shims do, which is everything except how they reach the
 * server and where they keep a setting.
 *
 * The userscript and the extension differ in exactly three injected pieces:
 * storage, the transport, and how an HTTP call reaches the server. Every other
 * line -- find the element, name the media, mount the panel, wire the engine,
 * sign in, decide what a navigation means -- is identical, so it lives here
 * rather than in two files that would drift.
 */
import { Html5Adapter } from '../adapter/html5.ts';
import { continuesMedia, followableUrl, normalizeMediaKey, watchUrl } from '../adapter/mediakey.ts';
import { PageWatcher } from '../adapter/resolve.ts';
import { SwappableAdapter } from '../adapter/swappable.ts';
import { builtinRegistry } from '../providers/registry.ts';
import type { Entry, ProviderRegistry } from '../providers/registry.ts';
import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../engine/engine.ts';
import type { EngineStatus } from '../engine/engine.ts';
import type { MemberInfo } from '../engine/protocol.ts';
import type { Transport } from '../engine/transport.ts';
import { Panel } from '../ui/panel.ts';
import { AuthRequiredError, ServerAuth } from './auth.ts';
import type { SignInResult } from './auth.ts';
import type { AuthFetch } from './authfetch.ts';
import { trackGestures } from './gestures.ts';

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

/** Provider descriptors (D7), as far as the page needs them. */
export interface ProviderHooks {
  /** The descriptors in force: built-ins plus whatever the user took on. */
  registry: ProviderRegistry;
  /**
   * Descriptors the user pinned whose copy on `serverUrl` has changed. Asked
   * once per join. The page only mentions them; deciding happens where a page
   * cannot reach (the extension's own page, the userscript's menu).
   */
  updatesFrom?(serverUrl: string): Promise<ReadonlyArray<{ id: string; name: string }>>;
  /** Where the user goes to decide, for the notice: "확장 프로그램 설정" etc. */
  decideWhere?: string;
}

export interface Platform {
  store: Store;
  /** Without it, the built-in descriptors only. */
  providers?: ProviderHooks;
  /** How this shim reaches the server. The extension relays through its
   *  service worker; the userscript opens the socket directly. */
  makeTransport(serverUrl: string): Transport;
  /**
   * Every HTTP call to the server -- room creation, sign-in, tickets. Made
   * from the shim's privileged side (the extension's background, the
   * userscript's `GM_xmlhttpRequest`), which is also where the device token
   * lives: the app never sees it (`authfetch.ts`). The extension could not
   * make these calls from the page anyway, for the same reason the socket
   * lives in its worker.
   */
  authFetch: AuthFetch;
  /** Open a login tab. Without it, `window.open`, which a popup blocker may eat. */
  openTab?(url: string): void;
  /**
   * Why this server cannot be reached from this page, if it cannot. Returns a
   * human sentence or null. The two shims have genuinely different answers:
   * a page cannot reach a private address at all, but an extension's service
   * worker can (docs/BROWSER-FINDINGS.md §8, §9).
   */
  unreachable(serverUrl: string): string | null;
  /**
   * Leave the panel's shadow root open. For a probe build only: Firefox gives
   * a test driver no way into a content script's world, so its probe can only
   * reach the panel from the page, which is exactly what a shipped build must
   * not allow (see `Panel`).
   */
  openPanel?: boolean;
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
   * The panel's shadow root. It is closed to the page (see `Panel`), so this is
   * the way in for whoever holds this API -- the console and the browser
   * probes, which drive the panel as a user would.
   */
  panelRoot(): ShadowRoot;
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
    state: string; selfId: string; seq: number; blocked: boolean; acquisition: string;
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
 * `href` with the secret of its invite for `roomId` replaced by `secret`, or
 * null if its fragment carries no invite for that room or already this one.
 * Only the fragment is looked at, and only the secret in it changes. An invite
 * left in the address bar wins over the stored secret on the next load, so
 * after a rotation a reload would join with the old one and be refused.
 */
export function rewriteInviteSecret(href: string, roomId: string, secret: string): string | null {
  const at = href.indexOf('#');
  if (at < 0) return null;
  const hash = href.slice(at);
  const m = /([#&]videosync=)([^.&]+)\.([^&]+)/.exec(hash);
  if (!m || !m[1] || !m[2]) return null;
  try {
    if (decodeURIComponent(m[2]) !== roomId) return null;
  } catch {
    return null;
  }
  const next = `${hash.slice(0, m.index)}${m[1]}${m[2]}.${encodeURIComponent(secret)}${hash.slice(m.index + m[0].length)}`;
  return next === hash ? null : href.slice(0, at) + next;
}

/**
 * What a refused join tells the user to do. Only `join_refused` is about the
 * ID or the secret; a full room was reached with both right, and sending that
 * user off to re-check them is sending them the wrong way. (`auth_required`
 * never gets here: it opens the sign-in section instead.)
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

/** The descriptor in force for `href`'s host, and whoever tied for it. */
function providerAt(reg: ProviderRegistry, href: string): { entry: Entry | null; conflict: readonly Entry[] } {
  try {
    return reg.lookup(new URL(href).hostname);
  } catch {
    return { entry: null, conflict: [] };
  }
}

export function start(p: Platform): App {
  const reg = p.providers?.registry ?? builtinRegistry();
  const adapter = new SwappableAdapter();
  let engine: SyncEngine | null = null;
  let mediaKey = normalizeMediaKey(location.href, reg) ?? '';
  let mediaUrl = watchUrl(location.href, reg) ?? '';
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
   * Whether this session has seen the room's anchor yet. The first one is
   * always acted on: a room that names no media looks, by key alone, exactly
   * like the '' this page started with.
   */
  let anchorSeen = false;
  /**
   * What was on screen when the connection dropped. Taken down meanwhile --
   * a command sent now is dropped by a closed socket, and a follow cannot carry
   * a session that is not joined -- and put back by the next welcome, which
   * names the same room media and so would otherwise act on nothing.
   */
  let resumeMedia: 'follow' | 'offer' | null = null;
  /** Whether the last status was 'joined', so leaving it is seen once. */
  let wasJoined = false;
  /**
   * Whether this session ever joined. A session that has is one whose member
   * believes they are in a room, so a drop has to be said out loud: what they
   * press while it is down reaches nobody, then or later. Cleared by `leave`,
   * which every join calls first.
   */
  let joinedOnce = false;
  /** The rejoin record this page last wrote, exactly as written. */
  let ownRejoin = '';
  /** How many `followRoom` passes are writing their rejoin record. */
  let writingRejoin = 0;
  let lastStatus: EngineStatus = 'idle';
  let session: { server: string; roomId: string; secret: string; name: string } | null = null;
  /** Whether `session` was started by its room's creator (`adoptLocalStateOnJoin`). */
  let sessionAdopts = false;
  /** What a successful sign-in should do next, and for which server. */
  let signInFor: { server: string; retry: () => void } | null = null;
  /** Bumped by every browser login and by whatever abandons one. */
  let loginAttempt = 0;
  /** A browser login is waiting on its tab. */
  let loginPending = false;
  /** The server this page knows the device to be signed in to. */
  let signedInTo = '';
  /**
   * A `hello` refused for want of a ticket is retried once, after asking the
   * server what it needs: what we believed about it may simply be stale.
   */
  let authRetried = false;
  let waitingOn: readonly string[] = [];
  let members: readonly MemberInfo[] = [];
  /** Pinned descriptors the joined server has another copy of, by id. */
  let updates = new Map<string, string>();
  /** Which of those the member has been told about this session. */
  const toldUpdates = new Set<string>();
  /** Bumped per join, so a late answer about a previous server is dropped. */
  let updatesGen = 0;
  /**
   * Bumped whenever the session changes hands -- every `leave`, and every
   * `join` the member asked for -- so a room creation that settles afterwards
   * is dropped. The app's own rejoin of the same session (`joinAgain`) is not
   * the member changing their mind, and leaves it alone.
   */
  let sessionGen = 0;

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
    onBrowserSignIn: () => { void browserSignIn(); },
    onCancelSignIn: () => {
      abandonLogin();
      panel.showSignInCode(null);
      panel.setSignInNotice('취소했어요. 다시 로그인할 수 있어요.', '');
    },
    onSignOut: () => { void signOut(); },
  }, p.openPanel ? 'open' : 'closed');
  // What the member does with their hands, as time only; see gestures.ts.
  const gestures = trackGestures(window, () => panel.hostElement, () => performance.now());

  const openTab = p.openTab ?? ((url: string) => { window.open(url, '_blank', 'noopener'); });
  const auth = new ServerAuth(p.authFetch, p.store, {
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => { clearTimeout(h); },
  }, openTab);

  /** The element the watcher last handed over, and the adapter made for it. */
  let wrapped: HTMLVideoElement | null = null;
  let wrapper: Html5Adapter | null = null;
  const watcher = new PageWatcher({
    doc: document,
    win: window,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => { clearTimeout(h); },
    hints: (href) => providerAt(reg, href).entry?.provider.d.video,
    onChange: (el, href) => {
      const key = normalizeMediaKey(href, reg) ?? '';
      mediaUrl = watchUrl(href, reg) ?? '';
      const mediaChanged = key !== mediaKey;
      if (mediaChanged) {
        mediaKey = key;
        // The engine has to know before the element is retargeted, not just
        // before its next evaluation: `setTarget` fires `elementreplaced`
        // synchronously, and an engine that still believes it is on the room's
        // media puts the new video at the old one's timestamp.
        engine?.setLocalMediaKey(key, mediaUrl);
      }
      // The same element on the same media is not new ground: an address that
      // changed only in its query or fragment -- our own invite rewrite after a
      // rotation, a site's `&t=` -- must not restart acquisition, which a
      // hidden tab never finishes, so the member would ignore the room until
      // the tab is shown (N5). The descriptor cannot differ either: a
      // same-document URL change keeps the host.
      if (el !== wrapped || mediaChanged || adapter.current !== wrapper) {
        wrapped = el;
        const d = providerAt(reg, href).entry?.provider.d;
        wrapper = el ? new Html5Adapter(el, 'html5', {
          ...(d?.capabilities ? { capabilities: d.capabilities } : {}),
          ...(d?.seek ? { seek: d.seek } : {}),
        }) : null;
        adapter.setTarget(wrapper);
      }
      if (mediaChanged) onMediaChanged();
      refreshStatus();
    },
  });
  watcher.start();

  {
    const { conflict, entry } = providerAt(reg, location.href);
    if (conflict.length) {
      // Neither applies, so this page is keyed by the built-in, by nothing,
      // or by the generic rule; a member whose other copy is not in conflict
      // computes a different key.
      panel.addChat('', `이 사이트를 설명하는 제공자 설명이 여럿이라 어느 것도 쓰지 않았어요: ${
        conflict.map((e) => e.provider.d.name).join(', ')}${entry ? ` (내장된 ${entry.provider.d.name} 설명을 대신 써요)` : ''}`, true);
    }
  }

  /**
   * "The server has an update for <name>", said when the member presses play
   * on that provider -- the moment it matters -- and once. Only said: a page
   * can overlay the panel, so the decision is never offered here.
   */
  const offUpdateNotice = adapter.on('play', () => {
    const id = providerAt(reg, location.href).entry?.provider.id;
    if (!id || !updates.has(id) || toldUpdates.has(id)) return;
    toldUpdates.add(id);
    panel.addChat('', `서버에 ${updates.get(id)} 제공자 설명의 새 버전이 있어요. 적용할지는 ${
      p.providers?.decideWhere ?? '설정'}에서 정할 수 있어요 (지금은 쓰던 버전 그대로예요).`, true);
  });

  function checkUpdates(serverUrl: string): void {
    const gen = ++updatesGen;
    updates = new Map();
    const ask = p.providers?.updatesFrom;
    if (!ask) return;
    ask(serverUrl).then((list) => {
      if (gen !== updatesGen) return;
      updates = new Map(list.map((u) => [u.id, u.name]));
    }, () => { /* no index is not worth a word: nothing changes either way */ });
  }

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
    if (onRoomMedia()) {
      clearMediaAction();
      return;
    }
    offerMoveRoom();
  }

  /**
   * Whether this page is the room's media. A page that names no media never
   * is -- not even in a room that names none either -- which is the engine's
   * rule too (`SyncEngine.onRoomMedia`).
   */
  function onRoomMedia(): boolean {
    return mediaKey !== '' && mediaKey === roomMediaKey;
  }

  function clearMediaAction(): void {
    panel.clearMediaAction();
    mediaUi = null;
  }

  function offerMoveRoom(): void {
    mediaUi = 'offer';
    if (!mediaKey && !roomMediaKey) {
      // Neither side names anything, so there is nothing to move and nothing
      // to follow. Without a word the member sits in the room and nothing
      // ever happens.
      panel.setMediaAction('아직 방에 영상이 없어요 — 영상을 열면 그 영상이 방의 영상이 돼요');
      return;
    }
    if (!roomMediaKey) {
      // The engine names the room from this page by itself (a conditional
      // `media` command); a button here would race it.
      panel.setMediaAction('이 영상을 방의 영상으로 정하는 중…');
      return;
    }
    if (!mediaKey) {
      // A button that cannot take the member anywhere redraws itself on every
      // press and looks broken; say where the room is instead.
      if (!followableUrl(roomMediaUrl, roomMediaKey, location.href, reg)) {
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
        // Decided against the room as it is on screen: if somebody moved it
        // meanwhile, the server refuses this and the member follows theirs.
        engine.setMedia(mediaKey, Math.round(adapter.readState().positionS * 1000), mediaUrl, roomMediaKey);
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

  /**
   * The secret rotated after a follow wrote its record: the next page would
   * join with the old one and be refused, which is final. Rewritten only
   * while it is still this page's record -- consumed, or replaced by another
   * tab, it is not ours to write -- and not while `followRoom` is writing,
   * which rebuilds it from `session` itself.
   */
  function refreshRejoin(): void {
    if (writingRejoin || !ownRejoin || !session) return;
    if (p.store.load('rejoin', '') !== ownRejoin) return;
    let r: Rejoin;
    try { r = JSON.parse(ownRejoin) as Rejoin; } catch { return; }
    if (r.server !== session.server || r.roomId !== session.roomId || r.secret === session.secret) return;
    const record = JSON.stringify({ ...r, secret: session.secret });
    p.store.save('rejoin', record);
    ownRejoin = record;
    void p.store.flush?.();
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
    if (onRoomMedia()) {
      clearMediaAction();
      return;
    }
    if (!roomMediaKey) {
      // The room names nothing to follow; offer to name this page instead.
      offerMoveRoom();
      return;
    }
    const target = followableUrl(roomMediaUrl, roomMediaKey, location.href, reg);
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
      writingRejoin++;
      try {
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
      } finally {
        writingRejoin--;
      }
      // From here the old document stays live, and joined, until the next one
      // commits; a rotation meanwhile is carried by `refreshRejoin`.
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
    // A room created from a page with no media names nothing, and stays quiet
    // until the first member on media names it (D8). Only a creator who is on
    // media seeds the room from their own player at once.
    panel.setStatus('방을 만드는 중…');
    const gen = sessionGen;
    try {
      const out = await requestRoom(serverUrl);
      // The member joined, left or created another room while this one was on
      // its way (the buttons stay live meanwhile). What they did since is
      // what they want; the room made here is simply never used (N9).
      if (gen !== sessionGen) throw new Error('superseded');
      panel.setFields(out);
      // The creator seeds the room from their own player. Only here: a joiner
      // conforms to the anchor, a creator IS the anchor.
      join(serverUrl, out.roomId, out.secret, name, true);
      return out;
    } catch (e) {
      if (gen !== sessionGen) throw e; // not about the session there is now
      if (e instanceof AuthRequiredError) {
        askSignIn(serverUrl, e.methods, () => { void createRoom(serverUrl, name).catch(() => {}); });
        throw e;
      }
      panel.setStatus(`방을 만들지 못했어요: ${(e as Error).message}. ` +
        '서버가 켜져 있는지, 주소가 맞는지 확인해주세요.', 'err');
      throw e;
    }
  }

  /**
   * `POST /api/rooms`, with a ticket if the server is known to want one. A
   * server that refuses for want of one is asked what it needs, once, and the
   * request is made again.
   */
  async function requestRoom(serverUrl: string, retried = false): Promise<{ roomId: string; secret: string }> {
    const ticket = auth.needs(serverUrl) === 'none' ? '' : await auth.ticket(serverUrl, 'create');
    if (ticket) noteSignedIn(serverUrl);
    const r = await p.authFetch(serverUrl, '/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ mediaKey, mediaUrl, ...(ticket ? { ticket } : {}) }),
    });
    if (r.status === 401 && !r.gateway) {
      if (retried) throw new AuthRequiredError((await auth.info(serverUrl).catch(() => null))?.methods ?? []);
      await auth.learnRefusal(serverUrl, 'create');
      return requestRoom(serverUrl, true);
    }
    if (r.status !== 201) {
      if (r.gateway) throw new Error(`서버 앞의 프록시가 막았어요 (${r.status})`);
      throw new Error(r.status ? `서버가 ${r.status}로 거절했어요` : (r.error ?? '응답이 없어요'));
    }
    const out = JSON.parse(r.body) as { roomId?: unknown; secret?: unknown };
    if (typeof out.roomId !== 'string' || typeof out.secret !== 'string') {
      throw new Error('서버의 응답을 이해할 수 없어요');
    }
    return { roomId: out.roomId, secret: out.secret };
  }

  // --- signing in -------------------------------------------------------------

  /** `who` is known only from a sign-in on this page; a ticket names nobody. */
  function noteSignedIn(server: string, who?: string): void {
    if (who === undefined && signedInTo === server) return;
    signedInTo = server;
    panel.setSignedIn(who ?? '');
  }

  /** Stop and ask. `retry` is what the sign-in was for. */
  function askSignIn(server: string, methods: readonly string[], retry: () => void): void {
    if (signedInTo === server) {
      // Whatever this page believed, the server just said otherwise.
      signedInTo = '';
      panel.setSignedIn(null);
    }
    panel.setStatus('로그인이 필요해요 — 아래에서 로그인해주세요.', 'warn');
    if (signInFor && signInFor.server === server) {
      // Asked again (방 만들기 pressed twice) while already asking: the same
      // sign-in, now for the newest request. A login in its tab is left
      // alone -- replacing the target used to drop its success on the floor,
      // and redrawing the section took its code off screen.
      signInFor.retry = retry;
      if (loginPending) return;
    } else {
      abandonLogin();
      signInFor = { server, retry };
    }
    panel.showSignIn({ methods, notice: '이 서버는 로그인이 필요해요.' });
  }

  /** Stop the browser login in progress, if any; its late result is dropped. */
  function abandonLogin(): void {
    auth.cancelBrowser();
    loginAttempt++;
    loginPending = false;
  }

  function finishSignIn(target: { server: string; retry: () => void }, r: SignInResult, attempt: number): void {
    if (signInFor !== target) return; // superseded, or the member left
    // Cancelled or replaced. A cancelled login can settle long after the
    // member started the next one for the same target (its request is not
    // aborted), and must not take that one's code off screen.
    if (attempt !== loginAttempt) return;
    loginPending = false;
    panel.showSignInCode(null);
    if (!r.ok) {
      if (r.why !== 'cancelled') panel.setSignInNotice(r.text, 'err');
      return;
    }
    signInFor = null;
    authRetried = false;
    panel.hideSignIn();
    noteSignedIn(target.server, r.sub);
    panel.setStatus('로그인했어요.');
    target.retry();
  }

  async function browserSignIn(): Promise<void> {
    const target = signInFor;
    if (!target) return;
    const attempt = ++loginAttempt;
    loginPending = true;
    panel.setSignInNotice('새 탭에서 로그인하세요. 탭에 아래와 같은 코드가 보일 때만 계속하세요.', '');
    panel.showSignInCode('…');
    const r = await auth.browserSignIn(target.server, (code) => {
      if (attempt === loginAttempt) panel.showSignInCode(code);
    });
    finishSignIn(target, r, attempt);
  }

  async function signOut(): Promise<void> {
    const server = signedInTo || panel.fields().serverUrl;
    if (!server) return;
    await auth.signOut(server);
    signedInTo = '';
    panel.setSignedIn(null);
    panel.setStatus('로그아웃했어요. 이 기기는 다음에 다시 로그인해야 해요.');
  }

  /**
   * The engine's ticket source. Synchronous for a server not known to gate
   * joining, so connecting to one costs exactly what it always did.
   */
  function joinTicket(server: string): Promise<string> | string {
    if (auth.needs(server) !== 'all') return '';
    // Called from inside the engine's connect, so `engine` is the one asking.
    // The answer can take seconds; a member who left, or joined elsewhere,
    // meanwhile must not be asked to sign in to the old server -- which would
    // also, on success, tear down the session they are in now.
    const e = engine;
    return auth.ticket(server, 'join').then((t) => {
      if (t && engine === e) noteSignedIn(server);
      return t;
    }, (err: unknown) => {
      if (err instanceof AuthRequiredError && engine === e) askSignIn(server, err.methods, joinAgain);
      throw err;
    });
  }

  /** Join the current session again, as it is now. */
  function joinAgain(): void {
    const s = session;
    if (s) join(s.server, s.roomId, s.secret, s.name, sessionAdopts, true);
  }

  /** The server refused `hello` for want of a ticket. */
  function onAuthRefused(server: string): void {
    if (signInFor) return; // already asking
    // Both answers below come later; by then the member may be in another
    // session, on this very server, which nothing here is about.
    const e = engine;
    if (!authRetried) {
      authRetried = true;
      void auth.learnRefusal(server, 'join').then(() => {
        if (engine === e && session?.server === server) joinAgain();
      });
      return;
    }
    void auth.info(server).then((i) => i.methods, () => [] as readonly string[]).then((methods) => {
      if (engine === e && session?.server === server && !signInFor) askSignIn(server, methods, joinAgain);
    });
  }

  function join(
    serverUrl: string, roomId: string, secret: string, name: string, adopt = false, internal = false,
  ): void {
    if (!serverUrl || !roomId || !secret) {
      panel.setStatus('서버 주소, 방 ID, 비밀키가 모두 필요해요.', 'err');
      return;
    }
    const why = p.unreachable(serverUrl);
    if (why) { panel.setStatus(why, 'err'); return; }
    leave(internal);

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
    sessionAdopts = adopt;
    // A join the member asked for gets its own retry.
    if (!internal) authRetried = false;
    checkUpdates(serverUrl);

    engine = new SyncEngine({
      adapter,
      transport,
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (h) => { clearTimeout(h); },
      isHidden: () => document.hidden,
      ticket: () => joinTicket(serverUrl),
      gestures,
      continues: (prev, next) => continuesMedia(prev, next, reg, location.hostname),
    }, {
      ...DEFAULT_ENGINE_CONFIG,
      room: roomId, secret, name: name || '익명', mediaKey, mediaUrl,
      adoptLocalStateOnJoin: adopt,
    }, {
      onStatus: (s: EngineStatus, detail?: string) => {
        panel.setConnection(s);
        panel.setJoined(s === 'joined', engine !== null);
        if (wasJoined && s !== 'joined') suspendMedia();
        wasJoined = s === 'joined';
        const prev = lastStatus;
        lastStatus = s;
        if (s === 'joined') joinedOnce = true;
        // A session that had joined and is not joined now: nothing the member
        // presses is reaching the room, and none of it is sent when the link
        // comes back (engine.ts `onClose`). A refusal is not this -- it is
        // over, the room is not coming back, and it says so in its own words.
        const dead = s === 'refused' || (prev === 'refused' && s === 'closed');
        panel.setDisconnected(joinedOnce && engine !== null && s !== 'joined' && !dead);
        // The server closes the socket right after refusing, and the close is
        // not news: "connection lost" in place of "check the room ID or
        // secret" sends the user off to debug their network.
        if (prev === 'refused' && s === 'closed') return;
        if (s === 'joined') authRetried = false;
        if (s === 'refused' && detail === 'auth_required') {
          // The sign-in section says it, or is about to; a retry needs no words.
          if (!signInFor && !authRetried) panel.setStatus('로그인 상태를 확인하는 중…');
          onAuthRefused(serverUrl);
          return;
        }
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
        // 'room' and 'secret' are separate keys in a store every tab of the
        // profile shares, and a join writes both. Saved alone over another
        // tab's room, this secret makes a pair no server accepts, and a new
        // tab prefills it.
        if (session && p.store.load('server', '') === session.server && p.store.load('room', '') === session.roomId) {
          p.store.save('secret', sec);
        }
        if (session) {
          session = { ...session, secret: sec };
          const href = rewriteInviteSecret(location.href, session.roomId, sec);
          // `replaceState` fires neither `hashchange` nor `popstate`, and the
          // site's own state goes back as it was.
          if (href) {
            try { history.replaceState(history.state, '', href); } catch { /* the link just stays stale */ }
          }
        }
        refreshRejoin();
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
        if (!anchorSeen || a.mediaKey !== roomMediaKey) {
          anchorSeen = true;
          roomMediaKey = a.mediaKey;
          followRoom();
        } else if (resume === 'follow') {
          followRoom();
        } else if (resume === 'offer') {
          if (onRoomMedia()) clearMediaAction();
          else offerMoveRoom();
        }
      },
      onAutoplayBlocked: () => panel.showGesturePrompt(document),
      // Started by a key or a media key, which the prompt does not catch.
      onAutoplayUnblocked: () => panel.hideGesturePrompt(),
      onAcquisition: (a) => {
        // The site keeps overriding the room, and the engine stopped fighting
        // it. Nothing is synced until the member presses something.
        if (a === 'fought') {
          panel.setStatus('이 플레이어가 방의 상태를 계속 바꿔요 — 재생이나 일시정지를 직접 눌러주세요.', 'warn');
        }
      },
      onError: (code, msg) => {
        if (code === 'rate_limited') {
          panel.setStatus('너무 빠릅니다 — 잠시 후 다시 시도해주세요.', 'warn');
          return;
        }
        // Said by `onStatus` already, in words that tell the user what to
        // check; the server's own words, when it has any, are added to them.
        if (code === 'auth_required') return; // `onStatus` acts on it
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

  /** `sameSession`: the app is about to join this very session again. */
  function leave(sameSession = false): void {
    if (!sameSession) sessionGen++;
    cancelFollow();
    // A sign-in asked for by what is being left would, on success, bring it back.
    abandonLogin();
    signInFor = null;
    panel.hideSignIn();
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
    anchorSeen = false;
    roomMediaUrl = '';
    stayedAwayFrom = '';
    resumeMedia = null;
    wasJoined = false;
    joinedOnce = false;
    lastStatus = 'idle';
    panel.setJoined(false);
    panel.setDisconnected(false);
    panel.setMembers([], '', []);
    clearMediaAction();
    panel.hideGesturePrompt();
    // `stop()` just reported 'closed' through the old engine's `onStatus`,
    // which reads as a network failure. Nobody's network failed: say what a
    // page with no session says. A join calling this says its own next.
    panel.setConnection('idle');
    refreshStatus();
  }

  // A member who navigates away or closes the tab should leave cleanly, so the
  // room does not hold the readiness gate for them until GATE_TIMEOUT.
  const onPageHide = () => { engine?.stop(); };
  window.addEventListener('pagehide', onPageHide);
  // A page kept in the back/forward cache comes back with no script re-run and
  // with the engine `pagehide` stopped for good, which read as a network
  // failure that never recovers -- and the server dropped the member long ago
  // (N20). Come back as a reload of this page would: out of the room, with its
  // fields still filled in. Not rejoined: the member left this page, and one
  // that is not the room's media would follow the room forward again.
  const onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted || !engine) return;
    // A follow's record belongs to the page it sent the member to, which may
    // still be about to consume it; a reload of this page leaves it too.
    ownRejoin = '';
    leave();
    panel.setStatus('페이지를 떠나서 방에서 나왔어요 — 다시 참가하려면 참가를 누르세요.', 'warn');
  };
  window.addEventListener('pageshow', onPageShow);

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
    panelRoot: () => panel.tree,
    dump() {
      const s = adapter.readState();
      const here = providerAt(reg, location.href);
      const e = here.entry;
      return JSON.stringify({
        at: new Date().toISOString(),
        url: redactInvite(location.href),
        mediaKey,
        mediaUrl,
        // Which descriptor decided the key, the element and the capabilities.
        // A field bug is one-shot; this is the question asked afterwards.
        provider: e ? {
          id: e.provider.id, name: e.provider.d.name, version: e.provider.d.version,
          sha256: e.sha256, tier: e.tier,
        } : { id: null, tier: 'generic' },
        providerConflict: here.conflict.map((c) => ({ id: c.provider.id, tier: c.tier, sha256: c.sha256 })),
        providerNotes: reg.notes,
        providerUpdates: [...updates.keys()],
        staleInclude: watcher.staleInclude,
        roomMediaKey,
        roomMediaUrl,
        // Never a token or a ticket: this code never holds the one, and the
        // other is spent by the time anyone could read it.
        auth: {
          needs: session ? auth.needs(session.server) : null,
          askingToSignIn: signInFor !== null,
          signedIn: signedInTo !== '',
        },
        engine: engine ? {
          state: engine.state,
          selfId: engine.id,
          appliedSeq: engine.appliedSeq,
          autoplayBlocked: engine.blocked,
          acquisition: engine.acquisition,
          wiring: engine.wiring,
          seedsRoom: engine.seedsRoom,
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
          readyState: s.readyState, muted: s.muted, ended: s.ended ?? null,
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
        acquisition: engine?.acquisition ?? '',
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
      offUpdateNotice();
      watcher.stop();
      gestures.stop();
      adapter.destroy();
      panel.destroy();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    },
  };
}

declare global {
  interface Window { VideoSync?: VideoSyncApi }
}
