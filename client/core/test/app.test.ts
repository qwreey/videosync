/**
 * The app layer: what `start()` does with the page, the panel and the store
 * around a session. Driven through a fake DOM (`fakedom.ts`) and the same
 * FakeTransport the engine tests use, with node's mocked `setTimeout` standing
 * in for the follow timer and the engine's own timers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { start } from '../src/app/bootstrap.ts';
import type { App, Platform, Store } from '../src/app/bootstrap.ts';
import type { ServerFrame } from '../src/engine/protocol.ts';
import { Panel } from '../src/ui/panel.ts';
import { FakeTransport, flush } from './fakes.ts';
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
): H {
  mock.timers.enable({ apis: ['setTimeout'] });
  useTab(tab);
  const dom = installDom(href);
  const transports: FakeTransport[] = [];
  const p: Platform = {
    store,
    makeTransport: () => { const t = new FakeTransport(); transports.push(t); return t; },
    createRoom: () => Promise.resolve({ roomId: 'R', secret: 'S' }),
    unreachable: () => null,
    ...extra,
  };
  const app = start(p);
  // The root is closed; `shadow` is the fake's way in, as `panelRoot()` is the
  // real one.
  const all = () => [...(dom.doc.getElementById('videosync-root')!.shadow!.walk())];
  const h: H = {
    dom, app, store, transports,
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
  });
});

describe('a page that names no media', () => {
  const NOWHERE = 'https://www.youtube.com/results?search_query=x';

  it('does not create a room nobody could follow', async () => {
    let created = 0;
    const h = harness(NOWHERE, makeStore(), new Map(), {
      createRoom: () => { created++; return Promise.resolve({ roomId: 'R', secret: 'S' }); },
    });
    await h.app.api.createRoom(SERVER, 'me').catch(() => {});
    assert.equal(created, 0, 'a keyless room is one the engine never follows');
    assert.equal(h.transports.length, 0);
    assert.match(h.status().text, /영상/);
    assert.match(h.status().cls, /err/);
  });

  it('tells a member in a room with no media that there is nothing to sync here', async () => {
    const h = harness(NOWHERE);
    h.join();
    h.welcome({ mediaKey: '' });
    await h.tick(100);
    assert.match(h.mediaNotice().text, /동기화할 영상/);
    assert.ok(h.mediaNotice().shown, 'the member would sit in the room with nothing happening and no word why');
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

  it('does not leak its secret through dump()', () => {
    const h = harness(`${ROOM_URL}#videosync=R1.SUPERSECRET`);
    const d = h.app.api.dump();
    assert.ok(!d.includes('SUPERSECRET'), 'the dump is meant to be pasted into an issue');
    assert.match(JSON.parse(d).url as string, /watch\?v=abc/, 'the page itself is still worth knowing');
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
