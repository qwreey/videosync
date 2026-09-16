/**
 * The privileged side's HTTP policy (`authfetch.ts`): where requests may go,
 * and that the device token is kept away from the caller.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeAuthFetch, memoryTokens } from '../src/app/authfetch.ts';
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
