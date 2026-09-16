/**
 * The engine's side of server access control: a ticket before every connect,
 * spent by the `hello` it rides in, and a refusal that ends the session
 * instead of retrying into the same answer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ENGINE_CONFIG, SyncEngine, TICKET_TIMEOUT_MS } from '../src/engine/engine.ts';
import { FakePlayer, FakeTransport, VirtualTime, flush } from './fakes.ts';

class NeedsSignIn extends Error {
  readonly code = 'auth_required';
}

interface Ticketing {
  vt: VirtualTime;
  tr: FakeTransport;
  engine: SyncEngine;
  statuses: string[];
  errors: string[];
  /** Every ticket request, answered by the test. */
  asks: Array<{ resolve(t: string): void; reject(e: unknown): void }>;
}

function rig(withTickets = true): Ticketing {
  const vt = new VirtualTime();
  const tr = new FakeTransport();
  const statuses: string[] = [];
  const errors: string[] = [];
  const asks: Ticketing['asks'] = [];
  const engine = new SyncEngine({
    adapter: new FakePlayer(vt),
    transport: tr,
    now: () => vt.now,
    setTimer: vt.setTimer,
    clearTimer: vt.clearTimer,
    isHidden: () => false,
    ...(withTickets ? {
      ticket: () => new Promise<string>((resolve, reject) => { asks.push({ resolve, reject }); }),
    } : {}),
  }, {
    ...DEFAULT_ENGINE_CONFIG, room: 'r', secret: 's', name: 'me', mediaKey: 'yt:abc',
  }, {
    onStatus: (s) => { statuses.push(s); },
    onError: (c) => { errors.push(c); },
  });
  return { vt, tr, engine, statuses, errors, asks };
}

const hellos = (r: Ticketing) => r.tr.sentOf('hello');

describe('tickets', () => {
  it('opens no socket until the ticket is in hand, and sends it in hello', async () => {
    const r = rig();
    r.engine.start();
    assert.equal(r.tr.connects, 0, 'a hello sent now would go without its ticket');
    assert.equal(r.asks.length, 1);
    r.asks[0]!.resolve('T1');
    await flush();
    assert.equal(r.tr.connects, 1);
    r.tr.open();
    assert.equal(hellos(r)[0]!.ticket, 'T1');
    r.engine.stop();
  });

  it('asks for a fresh ticket on every reconnect, never reusing the spent one', async () => {
    const r = rig();
    r.engine.start();
    r.asks[0]!.resolve('T1');
    await flush();
    r.tr.open();
    r.tr.drop();
    await r.vt.advance(1000);
    assert.equal(r.asks.length, 2, 'a reconnect did not ask for a ticket');
    assert.equal(r.tr.connects, 1);
    r.asks[1]!.resolve('T2');
    await flush();
    r.tr.open();
    assert.deepEqual(hellos(r).map((h) => h.ticket), ['T1', 'T2']);
    r.engine.stop();
  });

  it('stops for good when only signing in can help', async () => {
    const r = rig();
    r.engine.start();
    r.asks[0]!.reject(new NeedsSignIn('sign in'));
    await flush();
    assert.equal(r.engine.state, 'refused');
    assert.deepEqual(r.errors, ['auth_required']);
    await r.vt.advance(60_000);
    assert.equal(r.asks.length, 1, 'kept asking a server that had said no');
    assert.equal(r.tr.connects, 0);
  });

  it('treats any other failure as the network, and keeps trying', async () => {
    const r = rig();
    r.engine.start();
    r.asks[0]!.reject(new TypeError('Failed to fetch'));
    await flush();
    assert.equal(r.engine.state, 'connecting');
    await r.vt.advance(1000);
    assert.equal(r.asks.length, 2);
    r.asks[1]!.resolve('');
    await flush();
    r.tr.open();
    assert.equal(r.engine.stats.ticketFailures, 1);
    assert.equal(r.engine.stats.connectFailures, 0, 'the network\'s failure was filed as our bug');
    assert.equal(hellos(r).length, 1);
    assert.equal('ticket' in hellos(r)[0]!, false, 'an empty ticket should not be on the wire');
    r.engine.stop();
  });

  it('gives up on a ticket that never comes, and tries again', async () => {
    const r = rig();
    r.engine.start();
    await r.vt.advance(TICKET_TIMEOUT_MS - 100);
    assert.equal(r.asks.length, 1);
    await r.vt.advance(200);
    assert.equal(r.engine.stats.ticketFailures, 1);
    assert.equal(r.engine.state, 'connecting');
    // The first answer, arriving now -- before the reconnect -- opens nothing:
    // that attempt is over, and its ticket would ride a hello nobody scheduled.
    r.asks[0]!.resolve('late');
    await flush();
    assert.equal(r.tr.connects, 0);
    await r.vt.advance(5000);
    assert.equal(r.asks.length, 2, 'a stalled ticket request left the session with no reconnect');
    r.asks[1]!.resolve('T2');
    await flush();
    assert.equal(r.tr.connects, 1);
    r.tr.open();
    assert.deepEqual(hellos(r).map((h) => h.ticket), ['T2']);
    r.engine.stop();
  });

  it('opens nothing for a ticket that arrives after leaving', async () => {
    const r = rig();
    r.engine.start();
    r.engine.stop();
    r.asks[0]!.resolve('late');
    await flush();
    assert.equal(r.tr.connects, 0);
    assert.equal(r.engine.state, 'closed');
  });

  it('takes the server\'s auth_required as a refusal, not a dropped line', async () => {
    const r = rig();
    r.engine.start();
    r.asks[0]!.resolve('stale');
    await flush();
    r.tr.open();
    r.tr.deliver({ t: 'error', code: 'auth_required', msg: 'this server requires sign-in to join' });
    r.tr.drop('1008 auth required');
    await r.vt.advance(60_000);
    assert.equal(r.engine.state, 'closed');
    assert.ok(r.statuses.includes('refused'));
    assert.equal(r.asks.length, 1, 'reconnected after being refused');
  });

  it('connects at once when the answer is known without asking', () => {
    const tr = new FakeTransport();
    const vt = new VirtualTime();
    let asked = 0;
    const engine = new SyncEngine({
      adapter: new FakePlayer(vt), transport: tr, now: () => vt.now,
      setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false,
      ticket: () => { asked++; return ''; },
    }, { ...DEFAULT_ENGINE_CONFIG, room: 'r', secret: 's', name: 'me', mediaKey: 'yt:abc' });
    engine.start();
    assert.equal(asked, 1);
    assert.equal(tr.connects, 1, 'a server that wants no ticket must not cost a turn of the event loop');
    tr.open();
    assert.equal('ticket' in tr.sentOf('hello')[0]!, false);
    engine.stop();
  });

  it('without a ticket source, connects at once as it always did', () => {
    const r = rig(false);
    r.engine.start();
    assert.equal(r.tr.connects, 1);
    r.tr.open();
    assert.equal('ticket' in hellos(r)[0]!, false);
    r.engine.stop();
  });
});
