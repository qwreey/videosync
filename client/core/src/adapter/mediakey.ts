/**
 * Normalized media identity.
 *
 * `mediaKey` is what decides whether two people are watching the same thing.
 * It is deliberately NOT the URL: query parameters and tracking junk must not
 * fork a room, and two members who arrived by different routes to the same
 * episode must agree (docs/PROTOCOL.md §2).
 *
 * The general rule is `host:pathname` -- for essentially every video site the
 * path IS the content identity and everything after `?` is session noise. Only
 * providers that break that rule need an entry below, and so far only YouTube
 * does: its path is constant and the identity lives in `?v=`.
 */

/** One provider's rule for turning a location into an identity. */
export interface MediaKeyRule {
  readonly id: string;
  /** Host suffixes this rule claims, e.g. `youtube.com` matches `www.youtube.com`. */
  readonly hosts: readonly string[];
  /** Returns the key body, or null to fall through to the generic rule. */
  key(u: URL): string | null;
  /**
   * False for a provider whose identity is ONLY what `key` finds: where it
   * finds nothing, the page names no media, and the path must not stand in.
   */
  readonly pathFallback?: boolean;
  /**
   * Where the media with this key body can be opened. Only for a provider
   * whose identity is not simply its path; the generic rule is origin + path.
   */
  url?(body: string): string;
}

/** `/watch?v=ID`, `/embed/ID`, `/shorts/ID`, `/live/ID`, and youtu.be/ID. */
const YOUTUBE: MediaKeyRule = {
  id: 'yt',
  hosts: ['youtube.com', 'youtube-nocookie.com', 'youtu.be'],
  key(u) {
    if (u.hostname.endsWith('youtu.be')) {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id ?? null;
    }
    const v = u.searchParams.get('v');
    if (v) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0]!)) {
      return parts[1] ?? null;
    }
    return null;
    // Note what is deliberately dropped: `t`/`start` (where the linker was),
    // and `list`/`index` (which playlist they came in through). Neither changes
    // what is on screen right now, and both differ between two people who
    // reached the same video by different routes.
  },
  url: (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
  // Search, a channel, a feed, `/watch` with no `v`: no media, even while the
  // miniplayer keeps playing the room's video over them. Keyed on the path
  // they took that member out of the room and offered to move the room there.
  pathFallback: false,
};

/**
 * Laftel is a priority provider (D1) and uses the generic path rule.
 *
 * Listed explicitly because it is a priority provider, and because the rule is
 * now measured rather than assumed: `/player/<series>/<episode>` changes per
 * episode, including across the site's own client-side navigation, and is
 * stable across a reload (docs/BROWSER-FINDINGS.md §14).
 */
const LAFTEL: MediaKeyRule = {
  id: 'laftel',
  hosts: ['laftel.net'],
  key: () => null, // fall through to the path
};

export const RULES: readonly MediaKeyRule[] = [YOUTUBE, LAFTEL];

function providerFor(hostname: string): MediaKeyRule | null {
  const h = hostname.toLowerCase();
  for (const r of RULES) {
    for (const suffix of r.hosts) {
      if (h === suffix || h.endsWith(`.${suffix}`)) return r;
    }
  }
  return null;
}

/** A stable, human-legible provider id for a host, for UI and for the key. */
export function providerId(hostname: string): string {
  return providerFor(hostname)?.id ?? hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * `normalizeMediaKey('https://www.youtube.com/watch?v=abc&t=90')` -> `'yt:abc'`.
 *
 * Returns null for a URL that names no media at all (a site's front page), so
 * the caller can decline to join a room rather than joining one keyed on
 * nothing.
 */
export function normalizeMediaKey(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const rule = providerFor(u.hostname);
  const id = providerId(u.hostname);
  const explicit = rule?.key(u) ?? null;
  if (explicit) return `${id}:${explicit}`;
  if (rule?.pathFallback === false) return null;

  // Generic:the path is the identity. Trailing slash and case in the host are
  // noise; the path's own case is not (ids are often case-sensitive).
  const path = u.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/') return null;
  return `${id}:${path}`;
}

/**
 * Where the media at `href` can be opened by somebody else: the provider's
 * canonical watch URL, or origin + path. Never the query string or fragment --
 * a query is where sites keep session tokens and tracking, and a fragment is
 * where an invite carries the room secret. Null where `normalizeMediaKey` is.
 */
export function watchUrl(href: string): string | null {
  const key = normalizeMediaKey(href);
  if (!key) return null;
  const u = new URL(href);
  const rule = providerFor(u.hostname);
  const explicit = rule?.key(u) ?? null;
  if (explicit && rule?.url) return rule.url(explicit);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * The URL a member may be taken to so they can watch `roomKey`, or null.
 *
 * The URL comes from another member, so it is checked rather than trusted: it
 * must name exactly the room's media, and it must be on a provider this code
 * knows or on the site the member is already on. Without that, anyone in a
 * room could send everyone else to a page of their choosing.
 */
export function followableUrl(url: string | undefined, roomKey: string, currentHref: string): string | null {
  if (!url || !roomKey) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.hash) return null;
  if (normalizeMediaKey(u.href) !== roomKey) return null;
  let here: URL | null = null;
  try { here = new URL(currentHref); } catch { /* no current site to compare */ }
  const known = providerFor(u.hostname) !== null;
  const sameSite = here !== null && here.hostname.toLowerCase() === u.hostname.toLowerCase();
  if (!known && !sameSite) return null;
  // Never downgrade: a known provider is https, whatever the URL says.
  if (known && u.protocol !== 'https:') return null;
  return u.href;
}
