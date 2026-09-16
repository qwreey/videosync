/**
 * The media-key rules as they were code, before D7 moved them into
 * providers/*.json -- frozen here, verbatim, as the reference the built-in
 * descriptors are checked against (providers.test.ts). Members on the old
 * release compute keys this way; a new release that disagrees splits rooms.
 * Do not edit, except to rename the exports.
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
   * The canonical page for the media with this key body, on the provider's
   * own host. Without one, a page is opened at origin + path -- of whichever
   * host the URL named, which for a known provider is any subdomain of it.
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
  url: (path) => `https://laftel.net${path}`,
};

const RULES: readonly MediaKeyRule[] = [YOUTUBE, LAFTEL];

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
function providerId(hostname: string): string {
  return providerFor(hostname)?.id ?? hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * `normalizeMediaKey('https://www.youtube.com/watch?v=abc&t=90')` -> `'yt:abc'`.
 *
 * Returns null for a URL that names no media at all (a site's front page), so
 * the caller can decline to join a room rather than joining one keyed on
 * nothing.
 */
export function legacyNormalizeMediaKey(href: string): string | null {
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

  // Generic: the path is the identity. Trailing slash and case in the host are
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
export function legacyWatchUrl(href: string): string | null {
  const key = legacyNormalizeMediaKey(href);
  if (!key) return null;
  const u = new URL(href);
  const rule = providerFor(u.hostname);
  // A known provider's key is `<rule.id>:<body>`, whichever way the body was found.
  if (rule?.url) return rule.url(key.slice(rule.id.length + 1));
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
