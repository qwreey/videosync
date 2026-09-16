/**
 * Every HTTP call the app makes to its server, as one policy both shims run in
 * their privileged context: the extension's background, and the userscript's
 * `GM_xmlhttpRequest` side.
 *
 * The point is where the device token lives. It is the one long-lived
 * credential (docs/design/auth.md), and a content script can be taken over by
 * a page that compromises its renderer, so it never goes there: this code
 * stores it when the server hands it out, strips it from what the app sees,
 * and adds it itself to the requests that need it (the ticket, and the
 * provider listing a closed server gates). The app only ever
 * handles tickets, which are single-use and live a minute.
 *
 * And where requests go. The URL is built here from a server origin and a
 * fixed list of paths (`isAuthPath`, which the extension's provider fetches
 * share) -- never taken whole from the caller -- and a token is
 * only ever sent to the origin that issued it. The extension's old relay
 * fetched whatever `msg.url` said, from a context that can reach the LAN.
 *
 * No extension API in here: both shims bundle it.
 */

export const AUTH_PATHS = [
  '/healthz', '/api/rooms', '/api/session', '/api/ticket', '/api/auth/begin', '/api/auth/poll',
] as const;

/** The provider index and one descriptor file (D7). GET only. */
export type ProvidersPath = '/api/providers' | `/api/providers/${string}.json`;
export type AuthPath = typeof AUTH_PATHS[number] | ProvidersPath;

/**
 * Whether `path` is the provider index or one file in it. A file is named by
 * a descriptor id, which is `[a-z0-9-]{2,32}` -- so no `/`, `.` or `%` can
 * turn it into another path.
 */
export function isProvidersPath(path: string): path is ProvidersPath {
  return path === '/api/providers' || /^\/api\/providers\/[a-z0-9-]{2,32}\.json$/.test(path);
}

/** The one allowlist: every path the privileged side will fetch for anybody. */
export function isAuthPath(path: string): path is AuthPath {
  return (AUTH_PATHS as readonly string[]).includes(path) || isProvidersPath(path);
}

export type Credentials = { key: string } | { user: string; password: string };

export interface AuthRequest {
  /**
   * `DELETE /api/session` goes nowhere: the server keeps no sessions, so
   * signing out is forgetting the token.
   */
  method: 'GET' | 'POST' | 'DELETE';
  /** JSON. */
  body?: string;
  /** For `POST /api/session` only. Sent once and kept nowhere. */
  credentials?: Credentials;
}

export interface AuthResponse {
  /** 0: the request never got an answer. */
  status: number;
  body: string;
  /**
   * Something in front of the server answered instead of it -- a redirect, or
   * a page that is not our JSON. A gateway that wants a browser login.
   */
  gateway?: boolean;
  error?: string;
}

/** What `Platform.authFetch` is. */
export type AuthFetch = (serverUrl: string, path: AuthPath, req: AuthRequest) => Promise<AuthResponse>;

export interface HttpResult {
  status: number;
  body: string;
  contentType: string;
  /** A redirect was followed, or refused (`redirect: 'manual'`). */
  redirected: boolean;
}

/** The shim's raw HTTP. May throw; a throw is a network failure. */
export type RawHttp = (url: string, init: {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}) => Promise<HttpResult>;

/** Device tokens, one per server origin, somewhere a page cannot read. */
export interface TokenStore {
  get(origin: string): Promise<string>;
  set(origin: string, token: string): Promise<void>;
}

/** `http(s)://host[:port]`, or null for anything else. */
export function serverOrigin(serverUrl: string): string | null {
  try {
    const u = new URL(serverUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function utf8Base64(s: string): string {
  // `btoa` takes Latin-1; a password is not.
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authorization(c: Credentials): string {
  if ('key' in c) return `Bearer ${c.key}`;
  return `Basic ${utf8Base64(`${c.user}:${c.password}`)}`;
}

/** The two answers that may carry a device token. */
const MINTS: readonly AuthPath[] = ['/api/session', '/api/auth/poll'];

function isOurs(r: HttpResult): boolean {
  return !r.redirected && /\bjson\b/i.test(r.contentType);
}

export function makeAuthFetch(http: RawHttp, tokens: TokenStore): AuthFetch {
  return async (serverUrl, path, req) => {
    const origin = serverOrigin(serverUrl);
    if (!origin) return { status: 0, body: '', error: 'bad server url' };
    if (typeof path !== 'string' || !isAuthPath(path)) {
      return { status: 0, body: '', error: `path not allowed: ${String(path)}` };
    }
    const listing = isProvidersPath(path);
    if (listing && req.method !== 'GET') return { status: 0, body: '', error: 'the provider index is read-only' };
    if (req.method === 'DELETE') {
      if (path !== '/api/session') return { status: 0, body: '', error: 'only a session can be forgotten' };
      await tokens.set(origin, '');
      return { status: 204, body: '' };
    }

    const headers: Record<string, string> = {};
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (path === '/api/session' && req.credentials) headers['Authorization'] = authorization(req.credentials);
    // The listing is gated like room creation on a server with access control
    // on, and admits the device token itself (a ticket is single-use, and an
    // index plus its files is several requests). Same origin that issued it,
    // like every token this code sends.
    if (path === '/api/ticket' || listing) {
      const t = await tokens.get(origin);
      if (t) headers['Authorization'] = `Bearer ${t}`;
    }

    let r: HttpResult;
    try {
      r = await http(origin + path, { method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}) });
    } catch (e) {
      return { status: 0, body: '', error: e instanceof Error ? e.message : String(e) };
    }
    if (!isOurs(r)) {
      // Not videosyncd's answer, so it says nothing about our token: a gateway
      // refusing a path it should have left open must not sign the device out.
      return { status: r.status, body: '', gateway: true };
    }

    if (path === '/api/ticket' && r.status === 401) {
      // The server itself refused the token: expired, rotated key, method
      // switched off. Keeping it would make every connect fail the same way.
      await tokens.set(origin, '');
    }
    if (MINTS.includes(path) && r.status === 200) {
      try {
        const o = JSON.parse(r.body) as Record<string, unknown>;
        if (typeof o['token'] === 'string') {
          await tokens.set(origin, o['token']);
          delete o['token'];
          return { status: r.status, body: JSON.stringify({ ...o, signedIn: true }) };
        }
      } catch { /* fall through with the body as it was */ }
    }
    return { status: r.status, body: r.body };
  };
}

/**
 * `RawHttp` over the global `fetch`: the extension's background, and a
 * userscript with no `GM_xmlhttpRequest`.
 *
 * Redirects are not followed. A gateway that wants a login answers with one,
 * and following it lands on an HTML page on another origin, which CORS turns
 * into a bare "Failed to fetch" -- indistinguishable from a server that is
 * down. Refused, it is an opaque redirect we can name. No cookies either:
 * nothing under /api reads them, and with `Allow-Origin: *` a credentialed
 * request would fail CORS outright.
 */
export const fetchHttp: RawHttp = async (url, init) => {
  const r = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
  });
  const opaque = r.type === 'opaqueredirect';
  return {
    status: r.status,
    body: opaque ? '' : await r.text(),
    contentType: r.headers.get('content-type') ?? '',
    redirected: opaque || r.redirected || (r.status >= 300 && r.status < 400),
  };
};

/** A token store in memory, for a context with nowhere private to keep one. */
export function memoryTokens(): TokenStore {
  const m = new Map<string, string>();
  return {
    get: (o) => Promise.resolve(m.get(o) ?? ''),
    set: (o, t) => { if (t) m.set(o, t); else m.delete(o); return Promise.resolve(); },
  };
}
