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

function harness(href: string, store: FakeStore = makeStore()): H {
  mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom(href);
  const transports: FakeTransport[] = [];
  const p: Platform = {
    store,
    makeTransport: () => { const t = new FakeTransport(); transports.push(t); return t; },
    createRoom: () => Promise.resolve({ roomId: 'R', secret: 'S' }),
    unreachable: () => null,
  };
  const app = start(p);
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
});

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

  it('warns about a failed move only once', () => {
    const store = pending(ROOM_KEY);
    const h1 = harness('https://www.youtube.com/watch?v=login', store);
    assert.match(h1.status().text, /이동하지 못했어요/);
    h1.app.destroy(); h1.dom.uninstall(); mock.timers.reset();
    const h2 = harness('https://www.youtube.com/watch?v=unrelated', store);
    assert.doesNotMatch(h2.status().text, /이동하지 못했어요/);
  });

  it('is picked up, once, by the page it was meant for', () => {
    const store = pending(ROOM_KEY);
    const h = harness(ROOM_URL, store);
    assert.ok(h.app.api.engine(), 'did not rejoin');
    assert.equal(store.data.get('rejoin') ?? '', '');
  });
});
