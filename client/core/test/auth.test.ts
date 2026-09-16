/**
 * `ServerAuth` on its own: the answers a server or a gateway in front of it
 * can give, and what each one must and must not mean.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthRequiredError, LOGIN_WAIT_MS, POLL_MS, ServerAuth } from '../src/app/auth.ts';
import { flush, VirtualTime } from './fakes.ts';
import { FakeServer, gatewayPage, json, KEY } from './fakeserver.ts';

const SERVER = 'https://sync.example';

function rig(methods: string[], scope: 'create' | 'all' = 'create') {
  const server = new FakeServer();
  server.methods = methods;
  server.scope = scope;
  const vt = new VirtualTime();
  const data = new Map<string, string>();
  const opened: string[] = [];
  let clock = 1_000_000;
  const auth = new ServerAuth(server.fetch, {
    load: (k, fb = '') => data.get(k) ?? fb,
    save: (k, v) => { data.set(k, v); },
  }, { setTimer: vt.setTimer, clearTimer: vt.clearTimer, now: () => clock + vt.now }, (u) => { opened.push(u); });
  return { server, vt, auth, opened, data, skew: (ms: number) => { clock += ms; } };
}

describe('a gateway answering in the server\'s place', () => {
  it('is never a successful sign-in, whatever its status', async () => {
    for (const status of [200, 401, 302]) {
      const r = rig(['token', 'proxy']);
      r.server.override = (p) => (p === '/api/session' ? gatewayPage(status) : undefined);
      const out = await r.auth.signIn(SERVER, { key: KEY });
      assert.equal(out.ok, false, `a gateway ${status} signed in`);
      assert.equal(!out.ok && out.why, 'unsupported');
      assert.equal(await r.server.tokens.get(SERVER), '');
    }
  });

  it('is not a sign-in either when a 200 carries no device token', async () => {
    const r = rig(['token']);
    r.server.override = (p) => (p === '/api/session' ? json(200, { sub: 'someone' }) : undefined);
    const out = await r.auth.signIn(SERVER, { key: KEY });
    assert.equal(out.ok, false, 'signed in with nothing stored');
  });

  it('is a request to sign in when it answers the ticket, even with 200', async () => {
    const r = rig(['token']);
    await r.auth.signIn(SERVER, { key: KEY });
    r.server.override = (p) => (p === '/api/ticket' ? gatewayPage(200) : undefined);
    await assert.rejects(r.auth.ticket(SERVER, 'create'), AuthRequiredError);
  });

  it('does not stand in for the proxy\'s word at /api/session', async () => {
    const r = rig(['proxy']);
    let tickets = 0;
    r.server.override = (p) => {
      if (p === '/api/session') return gatewayPage(200);
      if (p === '/api/ticket') { tickets++; return json(401, { error: 'auth_required' }); }
      return undefined;
    };
    await assert.rejects(r.auth.ticket(SERVER, 'create'), AuthRequiredError);
    assert.equal(tickets, 1, 'retried the ticket as if the gateway page had signed us in');
  });

  it('ends a browser login when it answers the poll', async () => {
    const r = rig(['oidc']);
    r.server.override = (p) => (p === '/api/auth/poll' ? gatewayPage(200) : undefined);
    const done = r.auth.browserSignIn(SERVER, () => {});
    await flush();
    await r.vt.advance(POLL_MS);
    const out = await done;
    assert.equal(out.ok, false, 'a gateway page on the poll counted as signed in');
    assert.equal(!out.ok && out.why, 'unsupported');
  });
});

describe('a browser login', () => {
  async function started(methods = ['oidc']) {
    const r = rig(methods);
    let code = '';
    const done = r.auth.browserSignIn(SERVER, (c) => { code = c; });
    await flush();
    return { ...r, done, code: () => code };
  }

  it('says the server refused it, at once', async () => {
    const r = await started();
    r.server.override = (p) => (p === '/api/auth/poll' ? json(403, { error: 'login_denied', msg: 'not on the list' }) : undefined);
    await r.vt.advance(POLL_MS);
    const out = await r.done;
    assert.equal(!out.ok && out.why, 'denied');
    assert.match(!out.ok ? out.text : '', /not on the list/);
    assert.equal(r.server.to('/api/auth/poll').length, 1);
  });

  it('says it expired when the server forgot it', async () => {
    const r = await started();
    r.server.override = (p) => (p === '/api/auth/poll' ? json(404, { error: 'login_expired' }) : undefined);
    await r.vt.advance(POLL_MS);
    const out = await r.done;
    assert.equal(!out.ok && out.why, 'expired');
  });

  it('gives up by its own clock, however far this machine\'s clock is from the server\'s', async () => {
    const r = rig(['oidc']);
    // Ten minutes ahead of the server, whose expiresMs is on its own clock.
    r.skew(10 * 60_000);
    const done = r.auth.browserSignIn(SERVER, () => {});
    await flush();
    await r.vt.advance(POLL_MS * 3);
    assert.equal(r.server.to('/api/auth/poll').length, 3, 'gave up on the first poll');
    let out: Awaited<typeof done> | null = null;
    void done.then((o) => { out = o; });
    await r.vt.advance(LOGIN_WAIT_MS);
    await flush();
    assert.equal(out && !(out as { ok: boolean }).ok && (out as { why: string }).why, 'expired', 'polled past its own deadline');
  });

  it('opens only a web page', async () => {
    for (const bad of ['javascript:alert(1)', 'chrome-extension://x/options.html', 'file:///etc/passwd']) {
      const r = rig(['oidc']);
      r.server.override = (p) => (p === '/api/auth/begin' ? json(200, { loginUrl: bad, pollId: 'POLL', code: 'C' }) : undefined);
      const out = await r.auth.browserSignIn(SERVER, () => {});
      assert.equal(out.ok, false, bad);
      assert.deepEqual(r.opened, [], `opened ${bad}`);
    }
    const r = await started();
    assert.equal(r.opened.length, 1, 'control: a https login page is opened');
    r.auth.cancelBrowser();
  });
});

describe('what a refusal teaches', () => {
  it('believes the refusal over a /healthz that says less', async () => {
    const r = rig([]); // /healthz says access control is off
    await r.auth.learnRefusal(SERVER, 'join');
    assert.equal(r.auth.needs(SERVER), 'all', 'a refused hello means joining is gated, whatever /healthz said');
    const c = rig([]);
    await c.auth.learnRefusal(SERVER, 'create');
    assert.equal(c.auth.needs(SERVER), 'create');
    // And never lowers what the server itself says.
    const all = rig(['token'], 'all');
    await all.auth.learnRefusal(SERVER, 'create');
    assert.equal(all.auth.needs(SERVER), 'all');
  });
});
