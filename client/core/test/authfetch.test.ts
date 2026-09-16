/**
 * The privileged side's HTTP policy (`authfetch.ts`): where requests may go,
 * and that the device token is kept away from the caller.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEVICE_HEADER, fetchHttp, HTTP_TIMEOUT_MS, isAuthPath, isProvidersPath, makeAuthFetch, memoryTokens } from '../src/app/authfetch.ts';
import type { AuthPath, HttpResult, RawHttp } from '../src/app/authfetch.ts';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function json(status: number, body: unknown): HttpResult {
  return { status, body: JSON.stringify(body), contentType: 'application/json', redirected: false };
}

function rig(answer: (c: Call) => HttpResult | Promise<HttpResult>) {
  const calls: Call[] = [];
  const http: RawHttp = async (url, init) => {
    const c = { url, ...init };
    calls.push(c);
    return answer(c);
  };
  const tokens = memoryTokens();
  return { calls, tokens, fetch: makeAuthFetch(http, tokens) };
}

const S = 'https://sync.example:8443/some/path?x=1';
const ORIGIN = 'https://sync.example:8443';

describe('authFetch', () => {
  it('keeps the device token out of what the app sees, and sends it only where it is needed', async () => {
    const r = rig((c) => {
      if (c.url.endsWith('/api/session')) return json(200, { token: 'DEVICE', expiresMs: 5, sub: 'alice' });
      return json(200, { ticket: 'T', expiresMs: 5 });
    });
    const s = await r.fetch(S, '/api/session', { method: 'POST', credentials: { user: 'alice', password: '비밀' } });
    assert.equal(s.status, 200);
    assert.ok(!s.body.includes('DEVICE'), 'the token reached the content script');
    assert.deepEqual(JSON.parse(s.body), { expiresMs: 5, sub: 'alice', signedIn: true });
    assert.equal(r.calls[0]!.url, `${ORIGIN}/api/session`, 'the URL is the origin plus a fixed path');
    // UTF-8, not Latin-1: btoa alone throws on this password.
    assert.equal(r.calls[0]!.headers['Authorization'], `Basic ${Buffer.from('alice:비밀').toString('base64')}`);

    await r.fetch(S, '/api/ticket', { method: 'POST' });
    assert.equal(r.calls[1]!.headers['Authorization'], 'Bearer DEVICE');
    for (const p of ['/api/rooms', '/healthz', '/api/auth/begin', '/api/auth/poll'] as const) {
      await r.fetch(S, p, { method: 'POST', body: '{}' });
      assert.equal(r.calls.at(-1)!.headers['Authorization'], undefined, `${p} was sent the device token`);
    }
  });

  it('marks a session request as the privileged side\'s, so a trusted proxy may vouch for it', async () => {
    // The server takes a trusted proxy's word only with this header, which a
    // page cannot send cross-origin (auth.DeviceHeader): a trusted-network
    // sign-in posts with no credentials at all, and must still carry it.
    const r = rig(() => json(200, { token: 'DEVICE' }));
    await r.fetch(S, '/api/session', { method: 'POST' });
    assert.equal(r.calls[0]!.headers[DEVICE_HEADER], '1');
    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'k' } });
    assert.equal(r.calls[1]!.headers[DEVICE_HEADER], '1');
    assert.equal(DEVICE_HEADER, 'X-VideoSync-Device', 'the name the server checks');
  });

  it('takes a redirect for a gateway even when it lands on JSON', async () => {
    // Something in front of the server sent us elsewhere; whatever answered
    // there is not videosyncd, and a token in it is not ours to keep.
    const r = rig(() => ({ status: 200, body: JSON.stringify({ token: 'ELSEWHERE' }), contentType: 'application/json', redirected: true }));
    const out = await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'k' } });
    assert.equal(out.gateway, true);
    assert.equal(await r.tokens.get(ORIGIN), '', 'kept a token from wherever the redirect went');
  });

  it('sends a token only to the origin that issued it', async () => {
    const r = rig((c) => c.url.endsWith('/api/session')
      ? json(200, { token: 'DEVICE' }) : json(200, {}));
    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'k' } });
    await r.fetch('https://evil.example', '/api/ticket', { method: 'POST' });
    assert.equal(r.calls.at(-1)!.headers['Authorization'], undefined);
    await r.fetch('https://sync.example', '/api/ticket', { method: 'POST' }); // another port
    assert.equal(r.calls.at(-1)!.headers['Authorization'], undefined);
  });

  it('refuses anything but its own paths and web origins', async () => {
    const r = rig(() => json(200, {}));
    for (const p of ['/api/rooms/../../admin', 'https://evil.example/x', '/ws']) {
      const out = await r.fetch(S, p as AuthPath, { method: 'POST' });
      assert.equal(out.status, 0, p);
    }
    for (const s of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      assert.equal((await r.fetch(s, '/healthz', { method: 'GET' })).status, 0, s);
    }
    assert.equal(r.calls.length, 0);
  });

  it('fetches the provider index and files, GET only, with the device token for a gated listing', async () => {
    let listing: HttpResult = json(401, { error: 'auth_required' });
    const r = rig((c) => c.url.endsWith('/api/session') ? json(200, { token: 'DEVICE' }) : listing);
    // No token yet: sent without one, and the refusal is passed through.
    const before = await r.fetch(S, '/api/providers', { method: 'GET' });
    assert.equal(before.status, 401);
    assert.equal(r.calls[0]!.url, `${ORIGIN}/api/providers`);
    assert.equal(r.calls[0]!.headers['Authorization'], undefined);

    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'k' } });
    listing = json(200, { schema: 1, providers: [] });
    await r.fetch(S, '/api/providers/laftel.json', { method: 'GET' });
    assert.equal(r.calls.at(-1)!.url, `${ORIGIN}/api/providers/laftel.json`);
    assert.equal(r.calls.at(-1)!.headers['Authorization'], 'Bearer DEVICE', 'a gated listing needs the device token');
    assert.equal(r.calls.at(-1)!.method, 'GET');
    await r.fetch('https://evil.example', '/api/providers', { method: 'GET' });
    assert.equal(r.calls.at(-1)!.headers['Authorization'], undefined, 'the token went to another origin');

    // A refused listing says nothing about the token: only /api/ticket's does.
    listing = json(401, { error: 'auth_required' });
    await r.fetch(S, '/api/providers', { method: 'GET' });
    assert.equal(await r.tokens.get(ORIGIN), 'DEVICE');

    const n = r.calls.length;
    for (const m of ['POST', 'DELETE'] as const) {
      assert.equal((await r.fetch(S, '/api/providers', { method: m, body: '{}' })).status, 0, m);
    }
    assert.equal(r.calls.length, n, 'the listing is read-only');
    assert.equal(await r.tokens.get(ORIGIN), 'DEVICE', 'a DELETE on the listing signed the device out');
  });

  it('has one path allowlist, and a provider file cannot name another path', () => {
    for (const p of ['/api/providers', '/api/providers/yt.json', '/api/providers/my-site-2.json', '/api/rooms', '/api/ticket']) {
      assert.ok(isAuthPath(p), p);
    }
    for (const p of [
      '/api/providers/', '/api/providers/../rooms.json', '/api/providers/a.json', '/api/providers/UP.json',
      '/api/providers/x%2f..json', '/api/providers/yt.json?x=1', '/api/providers/yt.json/', '/api/providers/yt',
      '/api/providersx', `/api/providers/${'a'.repeat(33)}.json`, '/api/providers/yt.json#f', 'https://evil.example/api/providers',
      '/api/rooms/../../admin', '/ws', '',
    ]) {
      assert.ok(!isAuthPath(p), p);
    }
    assert.ok(isProvidersPath('/api/providers') && !isProvidersPath('/api/rooms'));
  });

  it('forgets the token when the server refuses it, and only then', async () => {
    let ticket: HttpResult = json(401, { error: 'auth_required' });
    const r = rig((c) => c.url.endsWith('/api/session') ? json(200, { token: 'DEVICE' }) : ticket);
    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'k' } });

    // A gateway in front answering instead of the server says nothing about
    // our token.
    ticket = { status: 401, body: '<html>', contentType: 'text/html', redirected: false };
    const g = await r.fetch(S, '/api/ticket', { method: 'POST' });
    assert.equal(g.gateway, true);
    assert.equal(await r.tokens.get(ORIGIN), 'DEVICE');
    ticket = { status: 0, body: '', contentType: '', redirected: true };
    assert.equal((await r.fetch(S, '/api/ticket', { method: 'POST' })).gateway, true);
    assert.equal(await r.tokens.get(ORIGIN), 'DEVICE');

    ticket = json(401, { error: 'auth_required' });
    const refused = await r.fetch(S, '/api/ticket', { method: 'POST' });
    assert.equal(refused.status, 401);
    assert.equal(await r.tokens.get(ORIGIN), '', 'a refused token would fail every connect the same way');
  });

  it('forgets nothing on any other 401: a missing ticket is not a bad token', async () => {
    const r = rig((c) => c.url.endsWith('/api/session') ? json(200, { token: 'DEVICE' })
      : json(401, { error: 'auth_required' }));
    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'k' } });
    for (const p of ['/api/rooms', '/healthz', '/api/auth/begin', '/api/auth/poll', '/api/providers'] as const) {
      await r.fetch(S, p, { method: p === '/api/providers' || p === '/healthz' ? 'GET' : 'POST', body: '{}' });
      assert.equal(await r.tokens.get(ORIGIN), 'DEVICE', `a 401 on ${p} signed the device out`);
    }
  });

  it('does not let a late refusal of an old token sign out a fresh one', async () => {
    let release: () => void = () => {};
    const r = rig(async (c) => {
      if (c.url.endsWith('/api/session')) return json(200, { token: c.headers['Authorization'] === 'Bearer new' ? 'NEW' : 'OLD' });
      // The ticket request with the old token is slow, and refused.
      await new Promise<void>((res) => { release = res; });
      return json(401, { error: 'auth_required' });
    });
    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'old' } });
    const late = r.fetch(S, '/api/ticket', { method: 'POST' });
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(r.calls.at(-1)!.headers['Authorization'], 'Bearer OLD');
    // Another tab signs in meanwhile.
    await r.fetch(S, '/api/session', { method: 'POST', credentials: { key: 'new' } });
    assert.equal(await r.tokens.get(ORIGIN), 'NEW');
    release();
    assert.equal((await late).status, 401);
    assert.equal(await r.tokens.get(ORIGIN), 'NEW', 'the refusal of OLD signed NEW out');
  });

  it('signs out without a request', async () => {
    const r = rig(() => json(200, { token: 'DEVICE' }));
    await r.fetch(S, '/api/auth/poll', { method: 'POST', body: '{}' });
    assert.equal(await r.tokens.get(ORIGIN), 'DEVICE', 'a polled token is stored like a session one');
    const n = r.calls.length;
    await r.fetch(S, '/api/session', { method: 'DELETE' });
    assert.equal(await r.tokens.get(ORIGIN), '');
    assert.equal(r.calls.length, n);
  });

  it('reports a network failure as status 0', async () => {
    const r = rig(() => { throw new TypeError('Failed to fetch'); });
    const out = await r.fetch(S, '/healthz', { method: 'GET' });
    assert.equal(out.status, 0);
    assert.match(out.error ?? '', /Failed to fetch/);
  });
});

describe('fetchHttp', () => {
  /** The global fetch, replaced for one call; returns what it was asked. */
  async function withFetch(answer: () => Response | Promise<Response>, run: () => Promise<unknown>) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return answer(); }) as typeof fetch;
    try {
      return { out: await run(), seen };
    } finally {
      globalThis.fetch = real;
    }
  }

  it('sends no cookies, follows no redirect, caches nothing, and gives up in time', async () => {
    const { seen } = await withFetch(
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      () => fetchHttp('https://sync.example/api/ticket', { method: 'POST', headers: { a: 'b' } }));
    const init = seen[0]!.init;
    assert.equal(init.credentials, 'omit', 'a gateway cookie would ride along');
    assert.equal(init.redirect, 'manual', 'a login redirect would be followed into a CORS failure');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal, 'no deadline: a stalled server holds the call forever');
    assert.ok(HTTP_TIMEOUT_MS > 0 && HTTP_TIMEOUT_MS <= 30_000);
  });

  it('reports a refused redirect as one, and a 3xx as redirected', async () => {
    const opaque = Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' });
    Object.defineProperty(opaque, 'status', { value: 0 });
    const a = await withFetch(() => opaque, () => fetchHttp('https://sync.example/api/ticket', { method: 'POST', headers: {} }));
    assert.deepEqual(a.out, { status: 0, body: '', contentType: '', redirected: true });
    const b = await withFetch(() => new Response('', { status: 302, headers: { location: '/login' } }),
      () => fetchHttp('https://sync.example/api/ticket', { method: 'POST', headers: {} }));
    assert.equal((b.out as { redirected: boolean }).redirected, true);
    const c = await withFetch(() => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
      () => fetchHttp('https://sync.example/api/ticket', { method: 'POST', headers: {} }));
    assert.deepEqual(c.out, { status: 401, body: '{}', contentType: 'application/json', redirected: false });
  });
});
