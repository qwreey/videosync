/**
 * The app layer: what `start()` does with the page, the panel and the store
 * around a session. Driven through a fake DOM (`fakedom.ts`) and the same
 * FakeTransport the engine tests use, with node's mocked `setTimeout` standing
 * in for the follow timer and the engine's own timers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { rewriteInviteSecret, start } from '../src/app/bootstrap.ts';
import type { App, Platform, Store } from '../src/app/bootstrap.ts';
import type { ServerFrame } from '../src/engine/protocol.ts';
import { Panel } from '../src/ui/panel.ts';
import { FakePlayer, FakeTransport, flush, realTime } from './fakes.ts';
import { CODE, FakeServer, gatewayPage, json, KEY, LOGIN_URL, PASSWORD, USER } from './fakeserver.ts';
import { buildRegistry, sha256Hex } from '../src/providers/adoption.ts';
import { BUILTIN_SOURCES } from '../src/providers/builtin.gen.ts';
import type { Descriptor } from '../src/providers/descriptor.ts';
import { installDom } from './fakedom.ts';
import type { FakeElement, Installed } from './fakedom.ts';

const SERVER = 'https://sync.example';
const HOME = 'https://www.youtube.com/';
const ROOM_KEY = 'yt:abc';
const ROOM_URL = 'https://www.youtube.com/watch?v=abc';

interface FakeStore extends Store {
  data: Map<string, string>;
  /** Resolve every flush started so far. Only for a store made `async`. */
  release(): void;
}

function makeStore(async = false, init: Record<string, string> = {}): FakeStore {
  const data = new Map(Object.entries(init));
  let waiting: Array<() => void> = [];
  const s: FakeStore = {
    data,
    load: (k, fb = '') => data.get(k) ?? fb,
    save: (k, v) => { data.set(k, v); },
    release: () => { for (const r of waiting) r(); waiting = []; },
  };
  // The extension's store: writes land later, and flush waits for them.
  if (async) s.flush = () => new Promise<void>((r) => { waiting.push(r); });
  return s;
}

interface H {
  dom: Installed;
  app: App;
  store: FakeStore;
  transports: FakeTransport[];
  server: FakeServer;
  /** Login tabs the app asked for. */
  opened: string[];
  tr(): FakeTransport;
  root(): FakeElement;
  button(label: string): FakeElement | undefined;
  /** A button the user can actually see. */
  visibleButton(label: string): FakeElement | undefined;
  status(): { text: string; cls: string };
  mediaNotice(): { text: string; shown: boolean };
  memberTags(): string[];
  join(): void;
  welcome(anchor: { mediaKey: string; mediaUrl?: string }, members?: string[]): void;
  tick(ms: number): Promise<void>;
}

let current: H | null = null;

/** One tab's `sessionStorage` (for its origin). A new Map is a new tab. */
type TabStorage = Map<string, string>;
const savedSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

function useTab(tab: TabStorage | null): void {
  const value = tab && {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => { tab.set(k, v); },
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    // No storage at all: reading it throws, as it does with site data blocked.
    get: () => { if (!value) throw new Error('SecurityError'); return value; },
  });
}

function harness(
  href: string, store: FakeStore = makeStore(), tab: TabStorage | null = new Map(), extra: Partial<Platform> = {},
  server: FakeServer = new FakeServer(),
): H {
  mock.timers.enable({ apis: ['setTimeout'] });
  useTab(tab);
  const dom = installDom(href);
  const transports: FakeTransport[] = [];
  const opened: string[] = [];
  const p: Platform = {
    store,
    makeTransport: () => { const t = new FakeTransport(); transports.push(t); return t; },
    authFetch: server.fetch,
    openTab: (url) => { opened.push(url); },
    unreachable: () => null,
    ...extra,
  };
  const app = start(p);
  // The root is closed; `shadow` is the fake's way in, as `panelRoot()` is the
  // real one.
  const all = () => [...(dom.doc.getElementById('videosync-root')!.shadow!.walk())];
  const h: H = {
    dom, app, store, transports, server, opened,
    tr: () => transports[transports.length - 1]!,
    root: () => dom.doc.getElementById('videosync-root')!,
    button: (l) => all().find((e) => e.tagName === 'BUTTON' && e.textContent === l),
    visibleButton: (l) => all().find((e) => e.tagName === 'BUTTON' && e.textContent === l && e.shown),
    status: () => {
      // The first `.status` in document order is the status line; the media
      // notice comes after it.
      const e = all().find((x) => x.className.split(' ')[0] === 'status')!;
      return { text: e.textContent, cls: e.className };
    },
    mediaNotice: () => {
      const e = all().filter((x) => x.className.split(' ')[0] === 'status')[1]!;
      return { text: e.textContent, shown: e.shown && e.textContent !== '' };
    },
    memberTags: () => all().filter((x) => x.className === 'tag').map((x) => x.textContent),
    join: () => { app.api.join(SERVER, 'R', 'S', 'me'); },
    welcome: (anchor, members = ['me']) => {
      const t = h.tr();
      t.open();
      t.deliver({
        t: 'welcome', you: 'me', seq: 0,
        anchor: { positionMs: 0, atServerMs: 0, paused: true, ...anchor },
        members: members.map((id) => ({ id, name: id, suspended: false, ready: true })),
        serverMs: 0, mediaKey: anchor.mediaKey,
      } as ServerFrame);
    },
    tick: async (ms) => {
      // One timer at a time, so each one's async continuation runs before the
      // next is due -- as it would in a browser.
      for (let left = ms; left > 0; left -= 50) {
        mock.timers.tick(Math.min(50, left));
        await flush();
      }
    },
  };
  current = h;
  return h;
}

afterEach(() => {
  current?.app.destroy();
  current?.dom.uninstall();
  current = null;
  mock.timers.reset();
  if (savedSession) Object.defineProperty(globalThis, 'sessionStorage', savedSession);
  else delete (globalThis as Record<string, unknown>)['sessionStorage'];
});

/**
 * The document goes away, the store stays: the next `harness` is the next page.
 * Not `destroy()`, which leaves the room -- a navigation does not.
 */
function unload(h: H): void {
  h.dom.uninstall();
  mock.timers.reset();
  current = null;
}

function savedRejoin(h: H): { secret: string; key: string } | null {
  const raw = h.store.data.get('rejoin');
  return raw ? JSON.parse(raw) as { secret: string; key: string } : null;
}

describe('following the room to its video', () => {
  it('takes the member there, and carries the session', async () => {
    const h = harness(HOME);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(2000);
    assert.deepEqual(h.dom.loc.assigned, [ROOM_URL]);
    assert.equal(savedRejoin(h)?.key, ROOM_KEY);
  });

  it('does not navigate if the member leaves while the session is still being written', async () => {
    const h = harness(HOME, makeStore(true));
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(2000);
    // go() has started: the write is in flight.
    assert.equal(h.dom.loc.assigned.length, 0);
    assert.equal(h.visibleButton('여기 있기'), undefined,
      'a "stay here" that can no longer stop anything must not be offered');
    h.button('나가기')!.click();
    h.store.release();
    await h.tick(100);
    assert.deepEqual(h.dom.loc.assigned, [], 'navigated after the member left');
    assert.equal(savedRejoin(h), null, 'the next page would rejoin the room the member left');
  });

  it('leaving after the navigation began still keeps the next page out of the room', async () => {
    const h = harness(HOME);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(2000);
    assert.equal(h.dom.loc.assigned.length, 1);
    // The old document stays interactive until the new one commits.
    h.app.api.leave();
    assert.equal(savedRejoin(h), null);
  });

  it('carries a secret rotated while the session is being written', async () => {
    const h = harness(HOME, makeStore(true));
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(2000);
    assert.equal(savedRejoin(h)?.secret, 'S');      // the write is in flight
    h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
    h.store.release();
    await h.tick(100);
    assert.equal(savedRejoin(h)?.secret, 'S2', 'the next page would be refused');
    assert.equal(h.dom.loc.assigned.length, 0, 'left before the new secret was written');
    h.store.release();
    await h.tick(100);
    assert.deepEqual(h.dom.loc.assigned, [ROOM_URL]);
    assert.equal(savedRejoin(h)?.secret, 'S2');
  });

  it('carries the secret the room has NOW, not the one it had when the follow was scheduled', async () => {
    const h = harness(HOME);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(500);
    h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
    await h.tick(1500);
    assert.equal(h.dom.loc.assigned.length, 1);
    assert.equal(savedRejoin(h)?.secret, 'S2', 'the next page would be refused');
  });

  it('carries a secret rotated after the navigation began, before the page unloaded', async () => {
    for (const async of [false, true]) {
      const store = makeStore(async);
      const tab: TabStorage = new Map();
      const h = harness(HOME, store, tab);
      h.join();
      h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
      await h.tick(2000);
      store.release();
      await h.tick(50);
      assert.equal(h.dom.loc.assigned.length, 1, 'control: the navigation began');
      // The old document is still live and joined until the next one commits.
      h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
      assert.equal(savedRejoin(h)?.secret, 'S2', `async=${async}: the next page would be refused`);
      unload(h);

      // The next page joins with it.
      const next = harness(ROOM_URL, store, tab);
      assert.equal(next.app.api.engine() !== null, true, 'control: the next page rejoined');
      next.tr().open();
      assert.equal(next.tr().sentOf('hello')[0]!.secret, 'S2');
      unload(next);
    }
  });

  it('does not write a rejoin record for a follow that is not under way', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(2000);
    h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
    assert.equal(savedRejoin(h), null);
  });

  it('survives a reconnect inside the grace period', async () => {
    const h = harness(HOME);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(1000);
    h.tr().drop();
    await h.tick(600);                   // the follow timer's moment passes while away
    const n = h.mediaNotice();
    assert.ok(!(n.shown && n.text === '방이 보는 영상으로 곧 이동해요'),
      'a banner promising a move that is not going to happen');
    assert.equal(h.dom.loc.assigned.length, 0);
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(2000);
    assert.deepEqual(h.dom.loc.assigned, [ROOM_URL], 'the follow was dropped for good');
  });

  it('never offers a button that cannot take the member anywhere', async () => {
    const h = harness(HOME);
    h.join();
    // A site this code does not know, and not the one the member is on.
    h.welcome({ mediaKey: 'videos.example.org:/watch/abc', mediaUrl: 'https://videos.example.org/watch/abc' });
    await h.tick(2000);
    assert.equal(h.dom.loc.assigned.length, 0);
    assert.ok(h.mediaNotice().shown, 'the member should still be told the room is elsewhere');
    assert.match(h.mediaNotice().text, /videos\.example\.org/);
    assert.equal(h.visibleButton('방 영상 열기'), undefined);
  });

  it('still offers the button when the room\'s video can be opened', async () => {
    const h = harness(HOME);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await h.tick(100);
    h.button('여기 있기')!.click();
    await h.tick(2000);
    assert.equal(h.dom.loc.assigned.length, 0);
    assert.ok(h.visibleButton('방 영상 열기'));
    h.visibleButton('방 영상 열기')!.click();
    await h.tick(100);
    assert.deepEqual(h.dom.loc.assigned, [ROOM_URL]);
  });
});

describe('the move-the-room offer', () => {
  const HERE = 'https://www.youtube.com/watch?v=mine';

  it('is withdrawn while reconnecting and comes back once joined', async () => {
    const h = harness(HERE);
    h.join();
    // No URL for the room's media: nothing to follow, so it becomes an offer.
    h.welcome({ mediaKey: ROOM_KEY });
    await h.tick(100);
    assert.ok(h.visibleButton('이 영상으로 방 옮기기'));
    h.tr().drop();
    await h.tick(100);
    assert.equal(h.visibleButton('이 영상으로 방 옮기기'), undefined,
      'a press here would be sent into a closed socket and lost');
    await h.tick(1000);
    h.welcome({ mediaKey: ROOM_KEY });
    await h.tick(100);
    const btn = h.visibleButton('이 영상으로 방 옮기기');
    assert.ok(btn, 'the offer was lost for good');
    const before = h.tr().sentOf('cmd').length;
    btn!.click();
    const media = h.tr().sentOf('cmd').slice(before);
    assert.equal(media.length, 1);
    assert.equal(media[0]!.kind, 'media');
    assert.equal(media[0]!.mediaKey, 'yt:mine');
    // Conditional on the room the button was shown against: pressed after
    // somebody else moved the room, it must not undo their move.
    assert.equal(media[0]!.ifMediaKey, ROOM_KEY);
  });
});

describe('a room creation that settles late (N9)', () => {
  /** `createRoom` with its POST held until `release`. */
  function held(h: H) {
    let release!: () => void;
    h.server.gate = new Promise<void>((r) => { release = r; });
    const out = h.app.api.createRoom(SERVER, 'me').then(() => 'created', (e: Error) => e.message);
    return { out, release: async () => { release(); await flush(); await flush(); } };
  }

  it('does not pull the member out of a room they joined meanwhile', async () => {
    const h = harness(ROOM_URL);
    const c = held(h);
    h.app.api.join(SERVER, 'B', 'SB', 'me');
    const b = h.tr();
    await c.release();
    assert.notEqual(await c.out, 'created', 'the caller was told it is in the created room');
    assert.equal(h.transports.length, 1, 'joined the created room over the one the member chose');
    assert.equal(b.closed, false);
    assert.equal(h.store.data.get('room'), 'B');
    assert.equal(h.server.to('/api/rooms').length, 1, 'control: the room was created');
  });

  it('does not put a member who left meanwhile into the room', async () => {
    const h = harness(ROOM_URL);
    const c = held(h);
    h.app.api.leave();
    await c.release();
    assert.equal(h.transports.length, 0);
    assert.equal(h.app.api.engine(), null);
  });

  it('joins only the first of two rooms created by a double click', async () => {
    const h = harness(ROOM_URL);
    const c1 = held(h);
    const c2 = h.app.api.createRoom(SERVER, 'me').then(() => 'created', (e: Error) => e.message);
    await c1.release();
    assert.equal(await c1.out, 'created');
    await c2;
    assert.equal(h.transports.length, 1, 'the second creation left the first room');
    assert.equal(h.tr().closed, false);
  });

  it('control: an undisturbed creation still joins', async () => {
    const h = harness(ROOM_URL);
    const c = held(h);
    await c.release();
    assert.equal(await c.out, 'created');
    assert.equal(h.transports.length, 1);
  });
});

describe('a page that names no media', () => {
  const NOWHERE = 'https://www.youtube.com/results?search_query=x';

  it('can create a room, which names nothing until somebody is on media (D8)', async () => {
    const h = harness(NOWHERE);
    await h.app.api.createRoom(SERVER, 'me');
    assert.deepEqual(h.server.to('/api/rooms').map((r) => r.body['mediaKey']), ['']);
    assert.equal(h.transports.length, 1, 'the creator did not join the room it made');
    h.welcome({ mediaKey: '' });
    await h.tick(3000);
    assert.deepEqual(h.tr().sentOf('cmd'), [], 'a page with no media named or seeded the room');
  });

  it('tells a member in a room with no media how it gets one', async () => {
    const h = harness(NOWHERE);
    h.join();
    h.welcome({ mediaKey: '' });
    await h.tick(100);
    assert.match(h.mediaNotice().text, /영상을 열면/);
    assert.ok(h.mediaNotice().shown, 'the member would sit in the room with nothing happening and no word why');
  });

  it('offers no button to a member on media in such a room: the engine names it', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: '' });
    await h.tick(100);
    assert.equal(h.visibleButton('이 영상으로 방 옮기기'), undefined);
    assert.match(h.mediaNotice().text, /정하는 중/);
  });
});

describe('the move-the-room offer, reconnecting', () => {
  it('is made for a video the member moved to while the connection was down', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    await h.tick(100);
    assert.equal(h.visibleButton('이 영상으로 방 옮기기'), undefined);
    h.tr().drop();
    h.dom.loc.href = 'https://www.youtube.com/watch?v=mine';
    await h.tick(1100);                  // the page watcher sees the navigation
    assert.equal(h.app.api.mediaKey(), 'yt:mine');
    h.welcome({ mediaKey: ROOM_KEY });
    await h.tick(100);
    assert.ok(h.visibleButton('이 영상으로 방 옮기기'),
      'the room is elsewhere and nothing says so');
  });

  it('sends nothing for a press that lands after the connection dropped', async () => {
    const h = harness('https://www.youtube.com/watch?v=mine');
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    await h.tick(100);
    // The handler as it was bound: the backstop behind taking the button down.
    const press = h.visibleButton('이 영상으로 방 옮기기')!.onclick!;
    h.tr().drop();
    const before = h.tr().sentOf('cmd').length;
    press({ type: 'click' });
    assert.equal(h.tr().sentOf('cmd').length, before);
  });
});

describe('the member list', () => {
  it('does not keep a buffering tag from before a reconnect', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY }, ['me', 'a']);
    h.tr().deliver({ t: 'gate', waiting: false, waitingOn: ['a'] });
    assert.ok(h.memberTags().includes('버퍼링'));
    h.tr().drop();
    await h.tick(1000);
    // The gate closed while we were away; the welcome does not say so.
    h.welcome({ mediaKey: ROOM_KEY }, ['me', 'a']);
    assert.ok(!h.memberTags().includes('버퍼링'), 'a stale tag nothing will ever clear');
  });
});

describe('a refused join', () => {
  it('stays on screen after the server closes the socket', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.tr().open();
    h.tr().deliver({ t: 'error', code: 'join_refused', msg: 'unknown room or secret' });
    h.tr().drop('1008 join refused');
    await h.tick(100);
    const s = h.status();
    assert.match(s.text, /거절/);
    assert.match(s.text, /비밀키를 확인/);
    assert.match(s.text, /unknown room or secret/, 'the server\'s own words were dropped');
    assert.match(s.cls, /\berr\b/);
  });

  it('because the room is full does not send the member to re-check the secret', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.tr().open();
    h.tr().deliver({ t: 'error', code: 'room_full' });
    h.tr().drop('1008 room full');
    await h.tick(100);
    const s = h.status();
    assert.doesNotMatch(s.text, /비밀키/);
    assert.match(s.text, /가득/);
    assert.match(s.text, /room_full/);
    assert.match(s.cls, /\berr\b/);
  });
});

describe('leaving', () => {
  const dot = (h: H) => [...h.root().shadow!.walk()].find((x) => x.className.split(' ')[0] === 'dot')!;

  it('is possible while the session is reconnecting, and stops it', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    h.tr().drop('net');
    await h.tick(1000);
    assert.equal(h.app.api.engine()?.state, 'connecting', 'control: the session is retrying');
    assert.equal(h.button('나가기')!.disabled, false, 'no way out of a session that keeps retrying');
    assert.equal(h.button('초대 링크 복사')!.disabled, true, 'control: what needs a live room stays off');
    h.button('나가기')!.click();
    const connects = h.tr().connects;
    await h.tick(60_000);
    assert.equal(h.app.api.engine(), null);
    assert.equal(h.tr().connects, connects, 'reconnected to a room the member left');
    assert.equal(h.button('나가기')!.disabled, true);
  });

  it('is possible while the session waits for a sign-in', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    server.scope = 'all';
    const store = makeStore(false, { authScope: JSON.stringify({ [new URL(SERVER).origin]: 'all' }) });
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    h.join();
    await h.tick(50);
    assert.equal(h.app.api.engine()?.state, 'refused', 'control: the session waits for a sign-in');
    assert.equal(h.button('나가기')!.disabled, false);
  });

  it('does not say the connection was lost', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    await h.tick(50);
    assert.match(dot(h).className, /\bjoined\b/, 'control: the dot is found');
    h.button('나가기')!.click();
    assert.doesNotMatch(h.status().text, /끊겼/, 'a member who left on purpose is told the network failed');
    assert.doesNotMatch(dot(h).className, /\bclosed\b/, 'a red dot for a deliberate leave');
  });
});

describe('a rotated secret', () => {
  it('is saved with its own room, never paired with another tab\'s', async () => {
    const h = harness(ROOM_URL);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
    assert.equal(h.store.data.get('secret'), 'S2', 'control: the room this page is in');
    // Another tab of the profile joins room Y and saves its pair.
    h.store.save('room', 'Y');
    h.store.save('secret', 'Ys');
    h.tr().deliver({ t: 'secret', secret: 'S3', rotated: 'other' });
    assert.deepEqual([h.store.data.get('room'), h.store.data.get('secret')], ['Y', 'Ys'],
      'a new tab would prefill room Y with room R\'s secret, and be refused');
  });
});

describe('an invite link', () => {
  it('fills the room fields', () => {
    const h = harness(`${ROOM_URL}#videosync=R1.S1`);
    const inputs = [...h.root().shadow!.walk()].filter((e) => e.tagName === 'INPUT');
    assert.ok(inputs.some((i) => i.value === 'R1'));
    assert.ok(inputs.some((i) => i.value === 'S1'));
  });

  it('that is malformed still lets the app start', () => {
    for (const hash of ['#videosync=AbC.x%E0%A4', '#videosync=%E0.abc']) {
      const h = harness(`${ROOM_URL}${hash}`);
      assert.ok(h.root(), `no panel for ${hash}`);
      h.app.destroy();
      h.dom.uninstall();
      mock.timers.reset();
      current = null;
    }
  });

  it('left in the address bar carries a rotated secret (N37)', async () => {
    const h = harness(`${ROOM_URL}&t=5#videosync=R.S`);
    h.dom.history.state = { app: 'the site\'s' };
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    h.tr().deliver({ t: 'secret', secret: 'S/2', rotated: 'other' });
    await flush();
    assert.equal(h.dom.loc.href, `${ROOM_URL}&t=5#videosync=R.S%2F2`,
      'a reload would prefill the old secret over the stored one, and be refused');
    assert.deepEqual(h.dom.history.replaced, [[{ app: 'the site\'s' }, h.dom.loc.href]],
      'replaced, not pushed, and the site\'s own history state kept');
  });

  it('for another room is left alone when this room\'s secret rotates', async () => {
    const h = harness(`${ROOM_URL}#videosync=Q.S`);
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
    await flush();
    assert.equal(h.store.data.get('secret'), 'S2', 'control: the rotation was handled');
    assert.equal(h.dom.loc.href, `${ROOM_URL}#videosync=Q.S`);
    assert.deepEqual(h.dom.history.replaced, []);
  });

  it('does not leak its secret through dump()', () => {
    const h = harness(`${ROOM_URL}#videosync=R1.SUPERSECRET`);
    const d = h.app.api.dump();
    assert.ok(!d.includes('SUPERSECRET'), 'the dump is meant to be pasted into an issue');
    assert.match(JSON.parse(d).url as string, /watch\?v=abc/, 'the page itself is still worth knowing');
  });
});

describe('rewriteInviteSecret', () => {
  const U = 'https://laftel.net/player/1/2?videosync=R.q';
  it('rewrites only the secret, keeping the rest of the fragment', () => {
    assert.equal(rewriteInviteSecret(`${U}#t=10&videosync=R.old&x=1`, 'R', 'new'),
      `${U}#t=10&videosync=R.new&x=1`);
    assert.equal(rewriteInviteSecret(`${U}#videosync=R%20x.old`, 'R x', 'a&b.c'),
      `${U}#videosync=R%20x.a%26b.c`);
  });
  it('leaves a link to another room, or no link, alone', () => {
    assert.equal(rewriteInviteSecret(`${U}#videosync=Q.old`, 'R', 'new'), null);
    assert.equal(rewriteInviteSecret(`${U}#videosync=RR.old`, 'R', 'new'), null);
    assert.equal(rewriteInviteSecret(U, 'R', 'new'), null, 'the query is not the fragment');
    assert.equal(rewriteInviteSecret(`${U}#t=10`, 'R', 'new'), null);
    assert.equal(rewriteInviteSecret(`${U}#videosync=%E0.old`, 'R', 'new'), null);
  });
  it('has nothing to do when the secret is already the new one', () => {
    assert.equal(rewriteInviteSecret(`${U}#videosync=R.new`, 'R', 'new'), null);
  });
});

describe('a pending rejoin', () => {
  const pending = (key: string) => makeStore(false, {
    rejoin: JSON.stringify({ server: SERVER, roomId: 'R', secret: 'S', name: 'me', key, until: Date.now() + 60_000 }),
  });

  it('is left alone by a page it was not meant for', () => {
    const store = pending(ROOM_KEY);
    harness('https://www.youtube.com/watch?v=unrelated', store);
    assert.equal(current!.app.api.engine(), null);
    assert.notEqual(store.data.get('rejoin') ?? '', '', 'another tab ate the session');
  });

  it('survives another tab leaving its own room', () => {
    const store = pending(ROOM_KEY);
    const h = harness(HOME, store);
    h.join();
    h.welcome({ mediaKey: 'yt:elsewhere' });
    h.app.api.join(SERVER, 'R2', 'S2', 'me');    // switching rooms leaves first
    h.app.api.leave();
    assert.equal(savedRejoin(h)?.key, ROOM_KEY, 'the member following in the other tab arrives out of the room');
  });

  it('warns about a failed move only once', () => {
    const store = pending(ROOM_KEY);
    const h1 = harness('https://www.youtube.com/watch?v=login', store);
    assert.match(h1.status().text, /이동하지 못했어요/);
    h1.app.destroy(); h1.dom.uninstall(); mock.timers.reset();
    const h2 = harness('https://www.youtube.com/watch?v=unrelated', store);
    assert.doesNotMatch(h2.status().text, /이동하지 못했어요/);
  });

  it('is neither taken nor warned about by another tab of the same site', async () => {
    // Tab A follows and is on its way.
    const store = makeStore();
    const a = harness(HOME, store, new Map());
    a.join();
    a.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await a.tick(2000);
    assert.equal(a.dom.loc.assigned.length, 1);
    unload(a);
    // Tab B, on the same site, opens the very video, then some other page.
    for (const href of [ROOM_URL, 'https://www.youtube.com/watch?v=other']) {
      const b = harness(href, store, new Map());
      assert.equal(b.app.api.engine(), null, `${href} joined another tab's room`);
      assert.doesNotMatch(b.status().text, /이동하지 못했어요/);
      unload(b);
    }
    assert.equal(savedRejoin({ store } as H)?.key, ROOM_KEY);
  });

  it('is warned about by its own tab, and taken by it on the right page', async () => {
    const store = makeStore();
    const tab: TabStorage = new Map();
    const a = harness(HOME, store, tab);
    a.join();
    a.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await a.tick(2000);
    unload(a);
    const login = harness('https://www.youtube.com/signin', store, tab);
    assert.match(login.status().text, /이동하지 못했어요/);
    unload(login);
    const back = harness(ROOM_URL, store, tab);
    assert.ok(back.app.api.engine(), 'the login round trip lost the room');
  });

  it('is still taken on the right page when nothing can tell tabs apart', async () => {
    const store = makeStore();
    const a = harness(HOME, store, null);
    a.join();
    a.welcome({ mediaKey: ROOM_KEY, mediaUrl: ROOM_URL });
    await a.tick(2000);
    unload(a);
    const b = harness(ROOM_URL, store, null);
    assert.ok(b.app.api.engine(), 'no storage must not mean no rejoin');
  });

  it('is picked up, once, by the page it was meant for', () => {
    const store = pending(ROOM_KEY);
    const h = harness(ROOM_URL, store);
    assert.ok(h.app.api.engine(), 'did not rejoin');
    assert.equal(store.data.get('rejoin') ?? '', '');
  });
});

describe('the panel', () => {
  function panel(dom: Installed, chats: string[] = []) {
    return new Panel(dom.doc as unknown as Document, { serverUrl: '', roomId: 'R', secret: 'S', name: '' }, {
      onCreateRoom() {}, onJoin() {}, onLeave() {}, onRotate() {}, onGesture() {},
      onChat: (t) => { chats.push(t); },
    });
  }
  const all = (dom: Installed) => [...dom.doc.getElementById('videosync-root')!.shadow!.walk()];

  it('does not send a line while the IME is still composing it', () => {
    const dom = installDom(ROOM_URL);
    try {
      const chats: string[] = [];
      panel(dom, chats);
      const input = all(dom).find((e) => e.placeholder === '메시지…')!;
      input.value = '안녕';
      // Each flag alone: browsers disagree on which one the committing Enter carries.
      input.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: true, keyCode: 13 });
      input.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: false, keyCode: 229 });
      assert.deepEqual(chats, []);
      assert.equal(input.value, '안녕', 'cleared under an open composition');
      input.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: false, keyCode: 13 });
      assert.deepEqual(chats, ['안녕']);
      assert.equal(input.value, '');
    } finally { dom.uninstall(); }
  });

  it('keeps every keystroke typed into it from the site\'s hotkeys (N7)', () => {
    const dom = installDom(ROOM_URL);
    try {
      panel(dom);
      const host = dom.doc.getElementById('videosync-root')!;
      // Key events are composed: past the shadow root they reach the page,
      // retargeted to the host, which no "is it editable?" check skips.
      host.shadow!.parentNode = host;
      const reached: string[] = [];
      for (const t of ['keydown', 'keyup', 'keypress']) {
        dom.doc.documentElement.addEventListener(t, (e) => {
          reached.push(`${t}:${e.target?.placeholder || e.target?.textContent || e.target?.tagName}`);
        });
      }
      const targets = all(dom).filter((e) => e.tagName === 'INPUT' || e.tagName === 'BUTTON');
      assert.ok(targets.some((e) => e.placeholder === '이름'), 'control: the name field is there');
      assert.ok(targets.some((e) => e.textContent === '나가기'), 'control: so is 나가기');
      for (const e of targets) {
        for (const type of ['keydown', 'keyup', 'keypress']) e.dispatchEvent({ type, key: type === 'keydown' ? 'l' : ' ' });
      }
      // Control: the page does hear a key pressed outside the panel.
      host.dispatchEvent({ type: 'keydown', key: 'k' });
      assert.deepEqual(reached, ['keydown:DIV'], 'YouTube would seek on the l typed into the server field');
    } finally { dom.uninstall(); }
  });

  it('keeps its root closed to the page', () => {
    const h = harness(ROOM_URL);
    assert.equal(h.root().shadowMode, 'closed', 'page scripts could read the secret and press the buttons');
    assert.equal(h.app.api.panelRoot(), h.root().shadow as unknown as ShadowRoot);
  });

  it('is left open only by a build that asks', () => {
    const h = harness(ROOM_URL, makeStore(), new Map(), { openPanel: true });
    assert.equal(h.root().shadowMode, 'open');
  });

  it('lets the collapse button receive its click', () => {
    const dom = installDom(ROOM_URL);
    try {
      panel(dom);
      const btn = all(dom).find((e) => e.textContent === '–')!;
      const head = btn.parentNode!;
      btn.dispatchEvent({ type: 'pointerdown', pointerId: 1, clientX: 0, clientY: 0 });
      assert.deepEqual(head.captured, [], 'the header captured a press meant for the button');
      btn.click();
      assert.ok(head.parentNode!.classList.contains('collapsed'));
      // The rest of the header still drags.
      head.children[1]!.dispatchEvent({ type: 'pointerdown', pointerId: 2, clientX: 0, clientY: 0 });
      assert.deepEqual(head.captured, [2]);
    } finally { dom.uninstall(); }
  });

  async function copyWith(clip: { writeText(s: string): Promise<void> } | undefined) {
    const dom = installDom(ROOM_URL);
    try {
      dom.setClipboard(clip);
      panel(dom);
      all(dom).find((e) => e.textContent === '초대 링크 복사')!.click();
      await flush();
      const st = all(dom).find((x) => x.className.split(' ')[0] === 'status')!;
      return st.textContent;
    } finally { dom.uninstall(); }
  }

  it('says the link was copied only when it was', async () => {
    let got = '';
    assert.match(await copyWith({ writeText: (s) => { got = s; return Promise.resolve(); } }), /복사했어요/);
    assert.match(got, /#videosync=R\.S$/);
    for (const clip of [undefined, { writeText: () => Promise.reject(new Error('NotAllowedError')) }]) {
      const text = await copyWith(clip);
      assert.doesNotMatch(text, /복사했어요/);
      assert.match(text, /#videosync=R\.S/, 'with no clipboard, the link has to be somewhere the user can take it');
    }
  });
});

describe('the engine the page builds', () => {
  it('has everything D6-D8 need: gesture evidence, the continuation rule, a ticket source', () => {
    const h = harness(ROOM_URL);
    h.join();
    const e = JSON.parse(h.app.api.dump()).engine;
    assert.deepEqual(e.wiring, { gestures: true, continues: true, ticket: true });
    // Gesture evidence is what turns acquisition on at all.
    assert.notEqual(e.acquisition, 'steady', 'a fresh page trusted a video it has not found yet');
  });

  it('asks the registry in force whether the next episode continues', async () => {
    // A user's Laftel copy that continues nothing: the page's engine must use it.
    const lf = JSON.parse(BUILTIN_SOURCES.find((b) => b.file === 'laftel.json')!.source) as Descriptor;
    const quiet = { ...lf, examples: lf.examples.filter((x) => 'url' in x) } as Descriptor;
    delete (quiet as { continues?: unknown }).continues;
    const source = JSON.stringify(quiet);
    const reg = buildRegistry({ user: [{ source, sha256: await sha256Hex(source) }], adopted: [], servers: {} }, () => false);
    const seen: boolean[] = [];
    for (const providers of [undefined, { registry: reg }]) {
      const h = harness('https://laftel.net/player/1/2', makeStore(), new Map(), providers ? { providers } : {});
      h.join();
      const engine = h.app.api.engine()! as unknown as { d: { continues(a: string, b: string): boolean } };
      seen.push(engine.d.continues('laftel:/player/1/2', 'laftel:/player/1/3'));
      unload(h);
    }
    assert.deepEqual(seen, [true, false], 'the page used a rule other than its own registry');
  });
});

describe('signing in to a server', () => {
  /** Every input field in the panel, by placeholder. */
  const inputs = (h: H) => [...h.root().shadow!.walk()].filter((x) => x.tagName === 'INPUT').map((x) => x.placeholder);

  /** Finish the login tab the panel opened. */
  async function signInByTab(h: H, server: FakeServer): Promise<void> {
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    server.browserDone = true;
    await h.tick(2100);
  }
  const note = (h: H) => [...h.root().shadow!.walk()].find((x) => x.className.split(' ')[0] === 'note')!;
  const signInShown = (h: H) => note(h).shown;
  const code = (h: H) => [...h.root().shadow!.walk()].find((x) => x.className === 'code')!;

  /** Everything the page could read, as one string. */
  function pageText(h: H): string {
    return [...h.root().shadow!.walk()].map((e) => `${e.textContent}|${e.value}`).join('\n') + h.app.api.dump();
  }

  async function create(h: H): Promise<void> {
    await h.app.api.createRoom(SERVER, 'me').catch(() => {});
    await h.tick(50);
  }

  it('costs a server with access control off nothing', async () => {
    const h = harness(ROOM_URL);
    await create(h);
    assert.deepEqual(h.server.requests.map((r) => r.path), ['/api/rooms'],
      'no /healthz, no ticket: a server without -auth must be reached exactly as before');
    assert.equal(h.server.requests[0]!.body['ticket'], undefined);
    assert.equal(h.transports.length, 1, 'the room was not joined');
    assert.equal(signInShown(h), false);
  });

  it('never asks for a key or a password in the page: the server\'s own tab takes them', async () => {
    // The panel is in the site's DOM, and a capture listener on the site's
    // window sees every key typed into it. The secrets that mint a device
    // token are therefore typed on the server's origin.
    for (const methods of [['token'], ['password'], ['token', 'password'], []]) {
      const server = new FakeServer();
      server.methods = methods.length ? methods : ['token'];
      const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
      if (!methods.length) server.override = (p) => (p === '/healthz' ? json(200, { ok: true }) : undefined);
      await create(h);
      assert.ok(signInShown(h), `${methods}: nothing asked the member to sign in`);
      // The room's own secret (D4) is not a server credential: it travels in the invite link.
      const secrets = inputs(h).filter((p) => ['접속 키', '비밀번호', '사용자'].includes(p));
      assert.ok(inputs(h).includes('참가 비밀키'), 'control: the walk sees the panel\'s inputs');
      assert.deepEqual(secrets, [], `${methods}: a secret field in the site's page`);
      assert.equal(h.visibleButton('로그인'), undefined, `${methods}: a submit for a secret typed in the page`);
      assert.ok(h.visibleButton('브라우저에서 로그인'), `${methods}: no way to sign in at all`);
      unload(h);
    }
  });

  it('signs in to a key server through the tab, and creates the room once signed in', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    assert.equal(h.transports.length, 0);
    assert.match(h.status().text, /로그인/);
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    assert.deepEqual(h.opened, [LOGIN_URL]);
    assert.equal(code(h).textContent, CODE);
    server.browserDone = true;
    await h.tick(2100);
    assert.equal(signInShown(h), false);
    assert.equal(h.transports.length, 1, 'signing in did not finish what it was for');
    const rooms = server.to('/api/rooms');
    assert.equal(rooms.length, 2);
    assert.match(String(rooms[1]!.body['ticket']), /^T/, 'the second attempt carried no ticket');
    assert.ok(h.visibleButton('로그아웃'));
    assert.ok(!pageText(h).includes('DEVICE-'), 'the device token reached the page');
    assert.equal(server.to('/api/session').length, 0, 'the page sent credentials of its own');
  });

  it('remembers what a server needs, so the next room goes straight for a ticket', async () => {
    const server = new FakeServer();
    server.methods = ['password'];
    const store = makeStore();
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    await create(h);
    await signInByTab(h, server);
    assert.equal(h.transports.length, 1);
    unload(h);

    const next = harness(ROOM_URL, store, new Map(), {}, server);
    const before = server.requests.length;
    await create(next);
    assert.deepEqual(server.requests.slice(before).map((r) => r.path), ['/healthz', '/api/ticket', '/api/rooms'],
      'a known server should not be refused first');
    assert.equal(signInShown(next), false, 'signed in once, asked again');
    assert.equal(next.transports.length, 1);
  });

  it('joins a server that gates joining with a ticket in hello, after learning so once', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    server.scope = 'all';
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    h.join();
    // Not known yet: the first hello goes without, and is refused.
    assert.equal(h.transports.length, 1);
    h.tr().open();
    assert.equal(h.tr().sentOf('hello')[0]!.ticket, undefined);
    h.tr().deliver({ t: 'error', code: 'auth_required', msg: 'this server requires sign-in to join' });
    h.tr().drop('1008 auth required');
    await h.tick(50);
    assert.doesNotMatch(h.status().text, /방 ID나 비밀키/, 'a sign-in problem was blamed on the room ID');
    assert.ok(signInShown(h));
    await signInByTab(h, server);
    assert.equal(h.transports.length, 3, 'one retry to learn, one join after signing in');
    h.tr().open();
    const t = h.tr().sentOf('hello')[0]!.ticket;
    assert.ok(server.spend(t), `hello carried ${t}, not a live ticket`);
    h.welcome({ mediaKey: ROOM_KEY });
    assert.equal(h.app.api.engine()?.state, 'joined');
  });

  it('retries a refused hello once without asking, when the device is still good', async () => {
    // A server restarted between the ticket and the hello loses the ticket;
    // the device token is still fine and nobody should be asked anything.
    const server = new FakeServer();
    server.methods = ['token'];
    server.scope = 'all';
    const store = makeStore();
    await server.fetch(SERVER, '/api/session', { method: 'POST', credentials: { key: KEY } });
    store.save('authScope', JSON.stringify({ [new URL(SERVER).origin]: 'all' }));
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    h.join();
    await h.tick(50);
    h.tr().open();
    assert.match(String(h.tr().sentOf('hello')[0]!.ticket), /^T/);
    h.tr().deliver({ t: 'error', code: 'auth_required' });
    h.tr().drop('1008 auth required');
    await h.tick(50);
    assert.equal(signInShown(h), false);
    h.tr().open();
    assert.ok(server.spend(h.tr().sentOf('hello')[0]!.ticket));
    // A second refusal in a row is not a stale ticket: ask.
    h.tr().deliver({ t: 'error', code: 'auth_required' });
    h.tr().drop('1008 auth required');
    await h.tick(50);
    assert.ok(signInShown(h), 'refused twice and still not asking');
    assert.equal(h.transports.length, 2, 'retried more than once');
  });

  it('keeps reconnecting a signed-in member through a gateway error page', async () => {
    // -auth-scope all behind nginx, and videosyncd restarting: /api/ticket is
    // nginx's 502 for a moment. Every device token is still good.
    const server = new FakeServer();
    server.methods = ['token'];
    server.scope = 'all';
    const store = makeStore();
    await server.fetch(SERVER, '/api/session', { method: 'POST', credentials: { key: KEY } });
    store.save('authScope', JSON.stringify({ [new URL(SERVER).origin]: 'all' }));
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    server.override = (p) => (p === '/api/ticket' ? gatewayPage(502) : undefined);
    h.join();
    await h.tick(50);
    assert.equal(signInShown(h), false, 'an outage asked a signed-in member to sign in');
    assert.notEqual(h.app.api.engine()?.state, 'refused', 'an outage ended the session for good');
    server.override = () => undefined;
    await h.tick(20_000);
    assert.equal(h.transports.length, 1, 'never reconnected once the server was back');
    h.tr().open();
    assert.ok(server.spend(h.tr().sentOf('hello')[0]!.ticket), 'the reconnect carried no live ticket');
    assert.equal(signInShown(h), false);
  });

  it('signs in through a browser tab and shows the code the tab will show', async () => {
    const server = new FakeServer();
    server.methods = ['oidc'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    assert.deepEqual(h.opened, [LOGIN_URL]);
    assert.equal(code(h).textContent, CODE);
    assert.ok(code(h).shown);
    await h.tick(4000);
    assert.ok(server.to('/api/auth/poll').length >= 2, 'not polling');
    assert.equal(h.transports.length, 0);
    server.browserDone = true;
    await h.tick(2100);
    assert.equal(signInShown(h), false);
    assert.equal(h.transports.length, 1, 'the room was not created after the tab finished');
    assert.ok(!pageText(h).includes('DEVICE-'));
  });

  it('stops polling when the member cancels or leaves', async () => {
    const server = new FakeServer();
    server.methods = ['oidc'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(2100);
    h.visibleButton('취소')!.click();
    const polls = server.to('/api/auth/poll').length;
    server.browserDone = true;
    await h.tick(10_000);
    assert.equal(server.to('/api/auth/poll').length, polls, 'polled after cancel');
    assert.equal(h.transports.length, 0, 'a cancelled sign-in still created the room');

    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(100);
    h.app.api.leave();
    const after = server.to('/api/auth/poll').length;
    await h.tick(10_000);
    assert.equal(server.to('/api/auth/poll').length, after, 'polled after leaving');
    assert.equal(signInShown(h), false);
  });

  it('asks nothing behind a proxy that already vouches for this browser', async () => {
    const server = new FakeServer();
    server.methods = ['proxy'];
    server.proxyVouches = true;
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    assert.equal(signInShown(h), false);
    assert.equal(h.transports.length, 1);
    const session = server.to('/api/session');
    assert.equal(session.length, 1);
    assert.equal(session[0]!.authorization, '', 'sent credentials nobody typed');
  });

  it('retries a refused room creation once, then asks', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    await server.fetch(SERVER, '/api/session', { method: 'POST', credentials: { key: KEY } });
    // A server that refuses every creation, ticket or not.
    server.override = (p) => (p === '/api/rooms' ? json(401, { error: 'auth_required', methods: ['token'] }) : undefined);
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    assert.equal(server.to('/api/rooms').length, 2, 'not exactly one retry');
    assert.ok(signInShown(h));
  });

  it('rejoins a creator as a creator after the server refused its hello', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    server.scope = 'all';
    const store = makeStore();
    await server.fetch(SERVER, '/api/session', { method: 'POST', credentials: { key: KEY } });
    store.save('authScope', JSON.stringify({ [new URL(SERVER).origin]: 'all' }));
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    await create(h);
    assert.equal(h.transports.length, 1);
    assert.equal(JSON.parse(h.app.api.dump()).engine.seedsRoom, true, 'control: the creator seeds the room');
    h.tr().open();
    h.tr().deliver({ t: 'error', code: 'auth_required' });
    h.tr().drop('1008 auth required');
    await h.tick(50);
    assert.equal(h.transports.length, 2, 'the refused hello was not retried');
    assert.equal(JSON.parse(h.app.api.dump()).engine.seedsRoom, true,
      'the retry joined as a plain member: adoptLocalStateOnJoin was lost');
  });

  it('does nothing with a sign-in that finishes after the member left', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    assert.ok(signInShown(h));
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    // The tab finishes while the poll that will say so is on its way.
    server.browserDone = true;
    let release: () => void = () => {};
    server.gate = new Promise((res) => { release = res; });
    await h.tick(2100);
    h.app.api.leave();
    release();
    await h.tick(100);
    assert.equal(server.to('/api/auth/poll').length, 1, 'the scenario needs a poll that was in flight');
    assert.equal(server.to('/api/rooms').length, 1, 'a room was created for a member who had left');
    assert.equal(h.transports.length, 0);
  });

  it('keeps the code of a login that replaced a cancelled one still on its way', async () => {
    const server = new FakeServer();
    server.methods = ['oidc'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    // Login A: its begin hangs (a request holds the gate it was sent under).
    let release: () => void = () => {};
    server.gate = new Promise((res) => { release = res; });
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    h.visibleButton('취소')!.click();
    // Login B goes through.
    server.gate = Promise.resolve();
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    assert.equal(code(h).textContent, CODE, 'control: B shows its code');
    release(); // A's begin finally answers, and A finds itself cancelled
    await h.tick(50);
    assert.equal(server.to('/api/auth/begin').length, 2, 'control: both logins began');
    assert.equal(code(h).textContent, CODE, 'a cancelled login blanked the code of the one that replaced it');
    assert.ok(code(h).shown);
    server.browserDone = true;
    await h.tick(2100);
    assert.equal(signInShown(h), false);
    assert.equal(h.transports.length, 1, 'control: B still finishes what it was for');
  });

  it('finishes a pending login when the same server asks again meanwhile', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    h.visibleButton('브라우저에서 로그인')!.click();
    await h.tick(50);
    assert.equal(code(h).textContent, CODE);
    await create(h); // 방 만들기 again, while the tab is still open
    assert.equal(code(h).textContent, CODE, 'the code of the login in progress was taken off screen');
    server.browserDone = true;
    await h.tick(2100);
    assert.equal(signInShown(h), false, 'signed in, and still asked to');
    assert.equal(h.transports.length, 1, 'the login finished and nothing was retried');
  });

  it('ignores a second refusal answered after the member joined another room on the same server', async () => {
    // Refused twice in a row, so the page reads /healthz for the methods to
    // offer. Before that answer lands the member leaves and joins another room
    // on the same server, which works: the late answer is not about it.
    const server = new FakeServer();
    server.methods = ['token'];
    server.scope = 'all';
    const store = makeStore();
    await server.fetch(SERVER, '/api/session', { method: 'POST', credentials: { key: KEY } });
    store.save('authScope', JSON.stringify({ [new URL(SERVER).origin]: 'all' }));
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    h.join();
    for (let i = 0; i < 2; i++) {
      await h.tick(50);
      h.tr().open();
      h.tr().deliver({ t: 'error', code: 'auth_required' });
      h.tr().drop('1008 auth required');
    }
    // Same turn as the second refusal: its /healthz answer is still to come.
    h.app.api.leave();
    h.app.api.join(SERVER, 'R2', 'S2', 'me');
    await h.tick(50);
    assert.equal(h.transports.length, 3, 'control: refused twice, then joined the other room');
    h.tr().open();
    assert.ok(server.spend(h.tr().sentOf('hello')[0]!.ticket), 'control: the new join carried a live ticket');
    h.welcome({ mediaKey: ROOM_KEY });
    assert.equal(signInShown(h), false, 'asked to sign in for a session the member already left');
    assert.equal(h.app.api.engine()?.state, 'joined');
    assert.equal(h.transports.length, 3, 'the new session was torn down and rebuilt');
  });

  it('ignores a join ticket refused after the member left, or moved to another server', async () => {
    const OTHER = 'https://other.example';
    for (const then of ['leave', 'join elsewhere'] as const) {
      const server = new FakeServer();
      server.methods = ['token'];
      server.scope = 'all';
      const store = makeStore(false, { authScope: JSON.stringify({ [new URL(SERVER).origin]: 'all' }) });
      const h = harness(ROOM_URL, store, new Map(), {}, server);
      let release: () => void = () => {};
      server.gate = new Promise((res) => { release = res; });
      h.join();
      await h.tick(50);
      assert.equal(server.requests.length, 0, 'control: the ticket request is held');
      if (then === 'leave') {
        h.app.api.leave();
      } else {
        h.app.api.join(OTHER, 'R2', 'S2', 'me');
        h.welcome({ mediaKey: ROOM_KEY });
        assert.equal(h.app.api.engine()?.state, 'joined', 'control: joined the other server');
      }
      const before = h.status().text;
      release();
      await h.tick(100);
      assert.ok(server.to('/api/ticket').length === 1, 'control: the ticket was refused late');
      assert.equal(signInShown(h), false, `${then}: asked to sign in to a server the member is not on`);
      assert.equal(h.status().text, before, `${then}: the status was taken over by the old server`);
      assert.equal(h.transports.length, then === 'leave' ? 1 : 2, `${then}: something rejoined`);
      unload(h);
    }
  });

  it('hides the signed-in row as soon as the server says otherwise', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    const h = harness(ROOM_URL, makeStore(), new Map(), {}, server);
    await create(h);
    await signInByTab(h, server);
    assert.ok(h.visibleButton('로그아웃'));
    h.app.api.leave();
    server.devices.clear(); // the server's key was rotated
    await create(h);
    assert.ok(signInShown(h));
    assert.equal(h.visibleButton('로그아웃'), undefined, 'still showing a sign-in the server just refused');
  });

  it('signs out, and is asked again next time', async () => {
    const server = new FakeServer();
    server.methods = ['token'];
    const store = makeStore();
    const h = harness(ROOM_URL, store, new Map(), {}, server);
    await create(h);
    await signInByTab(h, server);
    h.app.api.leave();
    h.visibleButton('로그아웃')!.click();
    await h.tick(50);
    assert.equal(h.visibleButton('로그아웃'), undefined);
    assert.equal(await server.tokens.get(new URL(SERVER).origin), '');
    await create(h);
    assert.ok(signInShown(h), 'signed out and still let in');
  });
});

describe('provider descriptors on the page', () => {
  const lines = (h: H) => [...h.root().shadow!.walk()]
    .filter((e) => e.className.split(' ').includes('line')).map((e) => e.textContent);

  const DESC: Descriptor = {
    schema: 1, id: 'example', name: 'Example', version: '1.2.3', adapter: 'html5',
    hosts: ['video.example'], canonicalHost: 'video.example',
    identity: [{ path: '/watch/{id}', key: '/watch/{id}', watch: 'https://video.example/watch/{id}' }],
    pathFallback: false,
    capabilities: { playbackRateNudge: false },
    video: { exclude: ['aside'] },
    examples: [{ url: 'https://video.example/watch/a', key: 'example:/watch/a' }],
  };

  async function userRegistry(...ds: Descriptor[]) {
    const user = [];
    for (const d of ds) {
      const source = JSON.stringify(d);
      user.push({ source, sha256: await sha256Hex(source) });
    }
    return buildRegistry({ user, adopted: [], servers: {} }, () => false);
  }

  /** Put one `<video>` on the fake page and let the watcher find it. */
  async function addVideo(h: H, parentTag = 'div') {
    const parent = h.dom.doc.createElement(parentTag);
    const v = h.dom.doc.createElement('video');
    parent.append(v);
    Object.assign(v, { videoWidth: 1920, videoHeight: 1080, duration: 60, paused: true, readyState: 4, muted: false,
      volume: 1, currentTime: 0, playbackRate: 1, buffered: { length: 0 } });
    h.dom.doc.querySelectorAll = (sel: string) => (sel === 'video' ? [v] : []);
    await h.tick(1000);
    return v;
  }

  it('reports the built-in in force through dump()', () => {
    const h = harness(ROOM_URL);
    const d = JSON.parse(h.app.api.dump());
    const yt = BUILTIN_SOURCES.find((b) => b.file === 'youtube.json')!;
    assert.deepEqual(d.provider, { id: 'yt', name: 'YouTube', version: '1.0.0', sha256: yt.sha256, tier: 'built-in' });
    assert.deepEqual(d.providerConflict, []);
  });

  it('reports the generic rule on a site nobody describes', () => {
    const h = harness('https://video.example/watch/a');
    const d = JSON.parse(h.app.api.dump());
    assert.deepEqual(d.provider, { id: null, tier: 'generic' });
    assert.equal(d.mediaKey, 'video.example:/watch/a');
  });

  it('keys the page, picks the element and masks the player by the user\'s descriptor', async () => {
    const reg = await userRegistry(DESC);
    const h = harness('https://video.example/watch/a', makeStore(), new Map(), { providers: { registry: reg } });
    assert.equal(h.app.api.mediaKey(), 'example:/watch/a');
    const d = JSON.parse(h.app.api.dump());
    assert.equal(d.provider.tier, 'user');
    assert.equal(d.provider.version, '1.2.3');

    await addVideo(h);
    assert.ok(h.app.api.adapter.current, 'the video was found');
    assert.equal(h.app.api.adapter.capabilities.supportsPlaybackRateNudge, false, 'the mask reached the adapter');
    assert.equal(h.app.api.adapter.capabilities.supportsDirectSeek, true);
  });

  it('hands the descriptor\'s seek timeout and landing tolerance to the element\'s adapter', async () => {
    const reg = await userRegistry({ ...DESC, seek: { timeoutMs: 1000, landingToleranceS: 2 } });
    const h = harness('https://video.example/watch/a', makeStore(), new Map(), { providers: { registry: reg } });
    const v = await addVideo(h);
    // Lands 1.5 s short: inside this provider's 2 s, outside the default 0.5 s.
    let landed = '';
    void h.app.api.adapter.seekTo(10).then(() => { landed = 'landed'; }, (e: Error) => { landed = e.message; });
    v.currentTime = 8.5;
    v.dispatchEvent({ type: 'seeked' });
    await flush();
    assert.equal(landed, 'landed');
    // Never lands: refused after this provider's 1 s, not the default 10 s.
    let out = '';
    void h.app.api.adapter.seekTo(30).then(() => { out = 'landed'; }, (e: Error) => { out = e.message; });
    await h.tick(1100);
    assert.match(out, /within 1000ms/);
  });

  it('drops an element the descriptor excludes', async () => {
    const reg = await userRegistry(DESC);
    const h = harness('https://video.example/watch/a', makeStore(), new Map(), { providers: { registry: reg } });
    await addVideo(h, 'aside');
    assert.equal(h.app.api.adapter.current, null);
    // Control: the same page without the descriptor takes it.
    h.app.destroy();
    h.dom.uninstall();
    mock.timers.reset();
    const plain = harness('https://video.example/watch/a');
    await addVideo(plain, 'aside');
    assert.ok(plain.app.api.adapter.current);
  });

  it('says so, and applies neither, when two descriptors tie for the site', async () => {
    const other = { ...DESC, id: 'other', name: 'Other', examples: [{ url: 'https://video.example/watch/a', key: 'other:/watch/a' }] };
    const reg = await userRegistry(DESC, other);
    const h = harness('https://video.example/watch/a', makeStore(), new Map(), { providers: { registry: reg } });
    assert.equal(h.app.api.mediaKey(), 'video.example:/watch/a');
    assert.ok(lines(h).some((l) => l.includes('Example') && l.includes('Other')), lines(h).join('|'));
    assert.deepEqual(JSON.parse(h.app.api.dump()).providerConflict.map((c: { id: string }) => c.id).sort(), ['example', 'other']);
  });

  it('mentions a server update when play is pressed on that provider, once', async () => {
    const asked: string[] = [];
    const h = harness(ROOM_URL, makeStore(), new Map(), {
      providers: {
        registry: (await userRegistry()),
        updatesFrom: (server) => { asked.push(server); return Promise.resolve([{ id: 'yt', name: 'YouTube' }]); },
        decideWhere: '확장 프로그램 설정',
      },
    });
    h.join();
    await flush();
    assert.deepEqual(asked, [SERVER]);
    const player = new FakePlayer(realTime);
    h.app.api.adapter.setTarget(player);
    assert.equal(lines(h).filter((l) => l.includes('새 버전')).length, 0, 'nothing before play');
    player.emit('play');
    player.emit('play');
    const said = lines(h).filter((l) => l.includes('새 버전'));
    assert.equal(said.length, 1, said.join('|'));
    assert.match(said[0]!, /YouTube/);
    assert.match(said[0]!, /확장 프로그램 설정/);
    assert.equal(h.visibleButton('적용'), undefined, 'the decision is never offered in the page');
  });

  it('keeps only the update list of the server it joined last', async () => {
    const answers = new Map<string, (v: Array<{ id: string; name: string }>) => void>();
    const h = harness(ROOM_URL, makeStore(), new Map(), {
      providers: {
        registry: (await userRegistry()),
        updatesFrom: (server) => new Promise((res) => { answers.set(server, res); }),
      },
    });
    h.app.api.join('https://old.example', 'R', 'S', 'me');
    h.app.api.leave();
    h.join();
    await flush();
    answers.get(SERVER)!([{ id: 'laftel', name: 'Laftel' }]);
    await flush();
    // The old server answers last; its list is about a server nobody is on.
    answers.get('https://old.example')!([{ id: 'yt', name: 'YouTube' }]);
    await flush();
    assert.deepEqual(JSON.parse(h.app.api.dump()).providerUpdates, ['laftel']);
  });

  it('does not mention an update for another provider', async () => {
    const h = harness(ROOM_URL, makeStore(), new Map(), {
      providers: {
        registry: (await userRegistry()),
        updatesFrom: () => Promise.resolve([{ id: 'laftel', name: 'Laftel' }]),
      },
    });
    h.join();
    await flush();
    const player = new FakePlayer(realTime);
    h.app.api.adapter.setTarget(player);
    player.emit('play');
    assert.equal(lines(h).filter((l) => l.includes('새 버전')).length, 0);
    assert.deepEqual(JSON.parse(h.app.api.dump()).providerUpdates, ['laftel']);
  });
});

describe('an address change on the same video (N5)', () => {
  /** One `<video>` on the page, found by the watcher's next check. */
  async function putVideo(h: H) {
    const v = h.dom.doc.createElement('video');
    h.dom.doc.documentElement.append(v);
    Object.assign(v, { videoWidth: 1920, videoHeight: 1080, duration: 60, paused: false, readyState: 4, muted: false,
      volume: 1, currentTime: 5, playbackRate: 1, buffered: { length: 0 } });
    h.dom.doc.querySelectorAll = (sel: string) => (sel === 'video' ? [v] : []);
    await h.tick(1000);
    return v;
  }

  it('keeps the element wrapped when only the invite fragment is rewritten', async () => {
    const h = harness(`${ROOM_URL}#videosync=R.S`);
    await putVideo(h);
    const wrapped = h.app.api.adapter.current;
    assert.ok(wrapped, 'control: the video was found');
    h.join();
    h.welcome({ mediaKey: ROOM_KEY });
    let replaced = 0;
    h.app.api.adapter.on('elementreplaced', () => { replaced++; });
    // Another member rotates the secret; the app rewrites this tab's fragment.
    h.tr().deliver({ t: 'secret', secret: 'S2', rotated: 'other' });
    assert.match(h.dom.loc.href, /#videosync=R\.S2$/, 'control: the address did change');
    await h.tick(2000);
    // A retarget restarts acquisition, which a hidden tab never finishes: the
    // member would ignore every room command until the tab is shown.
    assert.equal(replaced, 0, 'the same element was announced as a new one');
    assert.equal(h.app.api.adapter.current, wrapped);
  });

  it('still retargets when the address names another video on the same element', async () => {
    const h = harness(ROOM_URL);
    await putVideo(h);
    const wrapped = h.app.api.adapter.current;
    let replaced = 0;
    h.app.api.adapter.on('elementreplaced', () => { replaced++; });
    h.dom.loc.href = 'https://www.youtube.com/watch?v=other';
    await h.tick(1000);
    assert.equal(h.app.api.mediaKey(), 'yt:other');
    assert.ok(replaced > 0, 'a single-page navigation reusing the element is a new media');
    assert.notEqual(h.app.api.adapter.current, wrapped);
  });
});
