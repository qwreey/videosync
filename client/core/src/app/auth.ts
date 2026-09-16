/**
 * Signing in to a server, from the app's side (docs/design/auth.md, "Client
 * flow"). Everything here goes through `Platform.authFetch`, so this code
 * handles tickets and never a device token.
 *
 * A server with access control off costs nothing: no `/healthz` before a
 * connect, no ticket, no await. What a server needs is learned -- from
 * `/healthz` once it has refused something, or from a previous visit -- and
 * remembered per origin, so a page opened by following the room does not
 * rediscover it with a refused `hello`.
 */
import type { AuthFetch, AuthResponse, Credentials } from './authfetch.ts';
import { serverOrigin } from './authfetch.ts';
import type { Store } from './bootstrap.ts';

export type AuthScope = 'none' | 'create' | 'all';

export interface AuthInfo {
  methods: readonly string[];
  scope: AuthScope;
}

/** Only signing in can help. `code` is what `SyncEngine` recognises. */
export class AuthRequiredError extends Error {
  readonly code = 'auth_required';
  readonly methods: readonly string[];
  constructor(methods: readonly string[], msg = '로그인이 필요해요') {
    super(msg);
    this.methods = methods;
  }
}

export type SignInResult =
  | { ok: true; sub: string }
  | { ok: false; why: 'wrong' | 'denied' | 'expired' | 'rate' | 'network' | 'cancelled' | 'unsupported'; text: string };

export interface AuthTimers {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(h: number): void;
}

const SCOPES_KEY = 'authScope';
const RANK: Record<AuthScope, number> = { none: 0, create: 1, all: 2 };
/** How often a browser login is asked about. */
export const POLL_MS = 2000;

function parse(r: AuthResponse): Record<string, unknown> {
  try {
    const o = JSON.parse(r.body) as unknown;
    return typeof o === 'object' && o !== null ? o as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Can a login tab do anything on a server with these methods? */
export function hasBrowserLogin(methods: readonly string[]): boolean {
  return methods.includes('oidc') || methods.includes('proxy');
}

export class ServerAuth {
  private readonly fetch: AuthFetch;
  private readonly store: Store;
  private readonly timers: AuthTimers;
  private readonly openTab: (url: string) => void;
  private readonly infos = new Map<string, AuthInfo>();
  /** Bumped to abandon a browser login in progress. */
  private browserGen = 0;
  private pollTimer = 0;
  private pollWake: (() => void) | null = null;

  constructor(fetch: AuthFetch, store: Store, timers: AuthTimers, openTab: (url: string) => void) {
    this.fetch = fetch;
    this.store = store;
    this.timers = timers;
    this.openTab = openTab;
  }

  private scopes(): Record<string, AuthScope> {
    try {
      const o = JSON.parse(this.store.load(SCOPES_KEY, '{}')) as unknown;
      return typeof o === 'object' && o !== null ? o as Record<string, AuthScope> : {};
    } catch {
      return {};
    }
  }

  /** What this server is known to need, without asking it. */
  needs(server: string): AuthScope {
    const o = serverOrigin(server);
    return (o && this.scopes()[o]) || 'none';
  }

  private remember(server: string, scope: AuthScope): void {
    const o = serverOrigin(server);
    if (!o) return;
    const all = this.scopes();
    if ((all[o] ?? 'none') === scope) return;
    if (scope === 'none') delete all[o];
    else all[o] = scope;
    this.store.save(SCOPES_KEY, JSON.stringify(all));
  }

  /** Forget what the server said about itself; the next question asks again. */
  forget(server: string): void {
    const o = serverOrigin(server);
    if (o) this.infos.delete(o);
  }

  /**
   * `/healthz`'s `auth` section, cached for the page. A server that has none
   * is a server with access control off -- including one older than it.
   */
  async info(server: string): Promise<AuthInfo> {
    const o = serverOrigin(server);
    const cached = o ? this.infos.get(o) : undefined;
    if (cached) return cached;
    const r = await this.fetch(server, '/healthz', { method: 'GET' });
    if (r.status !== 200) throw new Error(r.gateway ? '서버 앞의 프록시가 응답했어요' : `서버에 연결하지 못했어요 (${r.error ?? r.status})`);
    const a = parse(r)['auth'] as { methods?: unknown; scope?: unknown } | undefined;
    const methods = strings(a?.methods);
    const scope: AuthScope = methods.length === 0 ? 'none' : a?.scope === 'all' ? 'all' : 'create';
    const info = { methods, scope };
    if (o) this.infos.set(o, info);
    this.remember(server, scope);
    return info;
  }

  /**
   * A ticket, or '' if this server wants none for `purpose`. Rejects with
   * `AuthRequiredError` when only signing in can help.
   */
  async ticket(server: string, purpose: 'join' | 'create'): Promise<string> {
    const info = await this.info(server);
    if (info.scope === 'none' || (purpose === 'join' && info.scope !== 'all')) return '';
    let r = await this.fetch(server, '/api/ticket', { method: 'POST' });
    if ((r.status === 401 || r.gateway) && info.methods.includes('proxy')) {
      // A trusted network, or a gateway that already knows this browser:
      // the proxy's word is taken at /api/session, and costs no prompt.
      const s = await this.fetch(server, '/api/session', { method: 'POST' });
      if (s.status === 200) r = await this.fetch(server, '/api/ticket', { method: 'POST' });
    }
    if (r.status === 200) {
      const t = parse(r)['ticket'];
      if (typeof t === 'string' && t) return t;
      throw new Error('서버가 이상한 티켓을 보냈어요');
    }
    if (r.status === 401 || r.gateway) throw new AuthRequiredError(info.methods);
    if (r.status === 429) throw new Error('요청이 너무 많아요 — 잠시 후 다시 시도해주세요');
    throw new Error(`티켓을 받지 못했어요 (${r.error ?? r.status})`);
  }

  /**
   * The server refused something for want of a ticket: whatever we believed
   * about it is stale.
   */
  async learnRefusal(server: string, purpose: 'join' | 'create'): Promise<void> {
    this.forget(server);
    const floor: AuthScope = purpose === 'join' ? 'all' : 'create';
    let info: AuthInfo = { methods: [], scope: 'none' };
    try {
      info = await this.info(server);
    } catch { /* unreadable: the refusal is all we know */ }
    if (RANK[info.scope] >= RANK[floor]) return;
    // The server's word about itself and its behaviour disagree -- a restart
    // with other flags in between, or a proxy rewriting /healthz. Behaviour
    // wins; the methods, if unknown, are asked for all at once.
    const o = serverOrigin(server);
    if (o) this.infos.set(o, { methods: info.methods, scope: floor });
    this.remember(server, floor);
  }

  async signIn(server: string, credentials: Credentials): Promise<SignInResult> {
    const r = await this.fetch(server, '/api/session', { method: 'POST', credentials });
    if (r.status === 200) return { ok: true, sub: String(parse(r)['sub'] ?? '') };
    if (r.status === 429) return { ok: false, why: 'rate', text: '시도가 너무 많아요 — 잠시 후 다시 해주세요' };
    if (r.status === 401) return { ok: false, why: 'wrong', text: '키나 비밀번호가 맞지 않아요' };
    if (r.gateway) {
      return { ok: false, why: 'unsupported', text: '서버 앞의 프록시가 막았어요 — 브라우저에서 로그인해주세요' };
    }
    return { ok: false, why: 'network', text: `서버에 연결하지 못했어요 (${r.error ?? r.status})` };
  }

  /**
   * A login in a tab: begin, open it, and poll until the server says who
   * logged in. `onCode` is told the code the tab will show, which is how the
   * user tells their own login from a link someone sent them.
   */
  async browserSignIn(server: string, onCode: (code: string) => void): Promise<SignInResult> {
    this.cancelBrowser();
    const gen = ++this.browserGen;
    const b = await this.fetch(server, '/api/auth/begin', { method: 'POST' });
    if (gen !== this.browserGen) return { ok: false, why: 'cancelled', text: '' };
    const body = parse(b);
    const loginUrl = typeof body['loginUrl'] === 'string' ? body['loginUrl'] : '';
    const pollId = typeof body['pollId'] === 'string' ? body['pollId'] : '';
    if (b.status !== 200 || !pollId || !/^https?:\/\//i.test(loginUrl)) {
      if (b.status === 404) return { ok: false, why: 'unsupported', text: '이 서버는 브라우저 로그인을 지원하지 않아요' };
      if (b.status === 429) return { ok: false, why: 'rate', text: '시도가 너무 많아요 — 잠시 후 다시 해주세요' };
      return { ok: false, why: 'network', text: `로그인을 시작하지 못했어요 (${b.error ?? b.status})` };
    }
    onCode(String(body['code'] ?? ''));
    this.openTab(loginUrl);
    const until = typeof body['expiresMs'] === 'number' ? body['expiresMs'] : Date.now() + 5 * 60_000;

    let wait = POLL_MS;
    for (;;) {
      await this.sleep(wait);
      if (gen !== this.browserGen) return { ok: false, why: 'cancelled', text: '' };
      wait = POLL_MS;
      const p = await this.fetch(server, '/api/auth/poll', { method: 'POST', body: JSON.stringify({ pollId }) });
      if (gen !== this.browserGen) return { ok: false, why: 'cancelled', text: '' };
      const pb = parse(p);
      if (p.status === 200 && pb['pending'] !== true) return { ok: true, sub: String(pb['sub'] ?? '') };
      if (p.status === 403) {
        return { ok: false, why: 'denied', text: `로그인이 거절됐어요${pb['msg'] ? `: ${String(pb['msg'])}` : ''}` };
      }
      if (p.status === 404) return { ok: false, why: 'expired', text: '로그인 시간이 지났어요 — 다시 시도해주세요' };
      if (p.status === 429 && typeof pb['retryMs'] === 'number') wait = Math.max(POLL_MS, pb['retryMs']);
      // Anything else is a blip: the tab may still finish.
      if (Date.now() > until) return { ok: false, why: 'expired', text: '로그인 시간이 지났어요 — 다시 시도해주세요' };
    }
  }

  cancelBrowser(): void {
    this.browserGen++;
    if (this.pollTimer) this.timers.clearTimer(this.pollTimer);
    this.pollTimer = 0;
    const wake = this.pollWake;
    this.pollWake = null;
    wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pollWake = resolve;
      this.pollTimer = this.timers.setTimer(() => {
        this.pollTimer = 0;
        this.pollWake = null;
        resolve();
      }, ms);
    });
  }

  async signOut(server: string): Promise<void> {
    this.cancelBrowser();
    await this.fetch(server, '/api/session', { method: 'DELETE' });
  }
}
