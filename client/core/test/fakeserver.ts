/**
 * videosyncd's HTTP surface, as far as sign-in goes, behind the shims' real
 * `makeAuthFetch`. The app layer is tested through the same token policy the
 * shims run, so a test that passes here has not skipped the part where the
 * device token is kept away from the app.
 */
import { makeAuthFetch, memoryTokens } from '../src/app/authfetch.ts';
import type { AuthFetch, HttpResult, TokenStore } from '../src/app/authfetch.ts';

export const KEY = 'friends-key';
export const USER = 'alice';
export const PASSWORD = 'hunter22';
export const LOGIN_URL = 'https://sync.example/auth/login?flow=F1';
export const CODE = 'BCDF-2345';

export interface Req { method: string; path: string; authorization: string; body: Record<string, unknown> }

/** A page from something in front of the server, with whatever status it chose. */
export function gatewayPage(status: number): HttpResult {
  return { status, body: '<html>sign in</html>', contentType: 'text/html', redirected: false };
}

export function json(status: number, body: unknown): HttpResult {
  return { status, body: JSON.stringify(body), contentType: 'application/json', redirected: false };
}

export class FakeServer {
  /** Empty: access control off, as `-auth none`. */
  methods: string[] = [];
  scope: 'create' | 'all' = 'create';
  /** `-auth proxy` on a trusted network: the proxy vouches for every request. */
  proxyVouches = false;
  /** The login tab has been finished (browser sign-in). */
  browserDone = false;
  /** Keys the server has minted and still accepts. */
  devices = new Set<string>();
  readonly requests: Req[] = [];
  readonly tickets = new Set<string>();
  private n = 0;
  readonly tokens: TokenStore = memoryTokens();
  /** Every answer waits for this: a test holds it to interleave. */
  gate: Promise<void> = Promise.resolve();
  /** Answers something else for a path: a gateway page, a refusal. */
  override: (path: string) => HttpResult | undefined = () => undefined;
  readonly fetch: AuthFetch;

  constructor() {
    this.fetch = makeAuthFetch((url, init) => this.gate.then(() => this.answer(url, init)), this.tokens);
  }

  get on(): boolean { return this.methods.length > 0; }

  /** Every request to `path`, in order. */
  to(path: string): Req[] { return this.requests.filter((r) => r.path === path); }

  /** Spend a ticket the way the hub does for a `hello`. */
  spend(t: string | undefined): boolean {
    if (!t || !this.tickets.has(t)) return false;
    this.tickets.delete(t);
    return true;
  }

  private mint(): string {
    const d = `DEVICE-${++this.n}`;
    this.devices.add(d);
    return d;
  }

  private answer(url: string, init: { method: string; headers: Record<string, string>; body?: string }): HttpResult {
    const u = new URL(url);
    const authz = init.headers['Authorization'] ?? '';
    let body: Record<string, unknown> = {};
    try { body = init.body ? JSON.parse(init.body) as Record<string, unknown> : {}; } catch { /* not JSON */ }
    this.requests.push({ method: init.method, path: u.pathname, authorization: authz, body });
    const o = this.override(u.pathname);
    if (o) return o;
    const refuse = () => json(401, { error: 'auth_required', methods: this.methods });
    switch (u.pathname) {
      case '/healthz':
        return json(200, { ok: true, rooms: 0, serverMs: 1, ...(this.on ? { auth: { methods: this.methods, scope: this.scope } } : {}) });
      case '/api/rooms': {
        if (this.on && !this.spend(body['ticket'] as string | undefined)) return refuse();
        return json(201, { roomId: 'R', secret: 'S' });
      }
      case '/api/session': {
        if (!this.on) return json(404, {});
        const ok = (this.methods.includes('proxy') && this.proxyVouches) ||
          (this.methods.includes('token') && authz === `Bearer ${KEY}`) ||
          (this.methods.includes('password') &&
            authz === `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`);
        if (!ok) return json(401, { error: 'auth_failed', methods: this.methods });
        return json(200, { token: this.mint(), expiresMs: 9e12, sub: this.proxyVouches ? 'proxy' : USER });
      }
      case '/api/ticket': {
        if (!this.on) return json(404, {});
        const dev = authz.replace(/^Bearer /, '');
        if (!this.devices.has(dev)) return refuse();
        const t = `T${++this.n}`;
        this.tickets.add(t);
        return json(200, { ticket: t, expiresMs: 9e12 });
      }
      case '/api/auth/begin':
        if (!this.methods.includes('oidc') && !this.methods.includes('proxy')) return json(404, { error: 'no_browser_login' });
        return json(200, { loginUrl: LOGIN_URL, pollId: 'POLL', code: CODE, expiresMs: Date.now() + 300_000 });
      case '/api/auth/poll':
        if (body['pollId'] !== 'POLL') return json(404, { error: 'login_expired' });
        if (!this.browserDone) return json(200, { pending: true });
        this.browserDone = false;
        return json(200, { token: this.mint(), expiresMs: 9e12, sub: 'alice@idp' });
      default:
        return json(404, {});
    }
  }
}
