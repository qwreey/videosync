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
};

/**
 * Laftel is a priority provider (D1) and uses the generic path rule.
 *
 * This is listed explicitly rather than left implicit because it is an
 * assumption, not a measurement: `research/provider-player-control.md` confirms
 * the *player* is a plain scriptable `<video>` but says nothing about the URL
 * shape. If a Laftel watch URL turns out to carry the episode in a query
 * parameter, this is the one place that has to change.
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

  // Generic: the path is the identity. Trailing slash and case in the host are
  // noise; the path's own case is not (ids are often case-sensitive).
  const path = u.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/') return null;
  return `${id}:${path}`;
}
