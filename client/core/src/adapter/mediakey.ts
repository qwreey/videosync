/**
 * Normalized media identity.
 *
 * `mediaKey` is what decides whether two people are watching the same thing.
 * It is deliberately NOT the URL: query parameters and tracking junk must not
 * fork a room, and two members who arrived by different routes to the same
 * episode must agree (docs/PROTOCOL.md §2).
 *
 * The general rule is `host:pathname` -- for essentially every video site the
 * path IS the content identity and everything after `?` is session noise.
 * Providers that break that rule, or whose paths are not all media, are
 * described by a provider descriptor (`providers/*.json`, D7), evaluated here.
 * Which descriptors are in force is the caller's `ProviderRegistry`; without
 * one, the built-ins compiled into this bundle.
 */
import { evaluate, genericPath, roundTrips } from '../providers/descriptor.ts';
import { builtinRegistry } from '../providers/registry.ts';
import type { Entry, ProviderRegistry } from '../providers/registry.ts';

function parse(href: string): URL | null {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function entryFor(hostname: string, reg: ProviderRegistry): Entry | null {
  return reg.lookup(hostname).entry;
}

/** A tie on a host a built-in describes: no media there at all (registry.ts). */
function blocked(hostname: string, reg: ProviderRegistry): boolean {
  return reg.lookup(hostname).blocked === true;
}

/** A stable, human-legible provider id for a host, for UI and for the key. */
export function providerId(hostname: string, reg: ProviderRegistry = builtinRegistry()): string {
  return entryFor(hostname, reg)?.provider.keyPrefix ?? hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * `normalizeMediaKey('https://www.youtube.com/watch?v=abc&t=90')` -> `'yt:abc'`.
 *
 * Returns null for a URL that names no media at all (a site's front page, or
 * any page a descriptor with `pathFallback: false` does not name), so the
 * caller can decline to join a room rather than joining one keyed on nothing.
 */
export function normalizeMediaKey(href: string, reg: ProviderRegistry = builtinRegistry()): string | null {
  const u = parse(href);
  if (!u) return null;
  const e = entryFor(u.hostname, reg);
  if (e) return e.provider.keyFor(u);
  if (blocked(u.hostname, reg)) return null;
  // Generic: the path is the identity. Trailing slash and case in the host are
  // noise; the path's own case is not (ids are often case-sensitive).
  const path = genericPath(u);
  return path ? `${providerId(u.hostname, reg)}:${path}` : null;
}

/**
 * Whether the room may follow a member from `prevKey` on to `nextKey` without
 * anybody pressing "move the room here": the provider says `next` continues
 * `prev`. Only same-provider keys can; YouTube never does, because autonav
 * picks an arbitrary recommendation.
 *
 * The one place this is decided: the descriptor's `continues` rules (D7),
 * read through the registry in force (Laftel: same series).
 */
export function continuesMedia(prevKey: string, nextKey: string, reg: ProviderRegistry = builtinRegistry()): boolean {
  if (!prevKey || !nextKey || prevKey === nextKey) return false;
  const colon = prevKey.indexOf(':');
  if (colon <= 0 || !nextKey.startsWith(prevKey.slice(0, colon + 1))) return false;
  const prefix = prevKey.slice(0, colon);
  // The descriptor that owns this key namespace decides. Two in force that
  // mint the same prefix cannot both be believed, and a continuation moves
  // the whole room, so an ambiguous namespace continues nothing.
  const owners = reg.entries.filter((e) => e.provider.keyPrefix === prefix);
  return owners.length === 1 && owners[0]!.provider.continues(prevKey, nextKey);
}

/**
 * Where the media at `href` can be opened by somebody else: the provider's
 * canonical watch URL, or origin + path. Never the query string or fragment --
 * a query is where sites keep session tokens and tracking, and a fragment is
 * where an invite carries the room secret. Null where `normalizeMediaKey` is,
 * and for a descriptor whose watch URL would not name the same media again.
 */
export function watchUrl(href: string, reg: ProviderRegistry = builtinRegistry()): string | null {
  const u = parse(href);
  if (!u) return null;
  const e = entryFor(u.hostname, reg);
  if (e) {
    const key = e.provider.keyFor(u);
    if (!key) return null;
    const raw = e.provider.rawWatchFor(u);
    // Checked here and not only in the descriptor's examples: the watch URL is
    // where every member of a room gets sent.
    return raw && roundTrips(e.provider, raw, key) && entryFor(new URL(raw).hostname, reg) === e ? raw : null;
  }
  if (blocked(u.hostname, reg)) return null;
  const path = genericPath(u);
  return path ? `${u.origin}${path}` : null;
}

/**
 * The URL a member may be taken to so they can watch `roomKey`, or null.
 *
 * The URL comes from another member, so it is checked rather than trusted: it
 * must name exactly the room's media, and it must be on a provider this client
 * trusts to name hosts -- a built-in, or a descriptor for a host the user has
 * granted -- or on the site the member is already on. Without that, anyone in
 * a room could send everyone else to a page of their choosing.
 *
 * What comes back is the canonical `watchUrl` for that media, never the URL
 * as sent. Naming the right media is not enough: YouTube's `?v=` is read on
 * any path of any subdomain, and the path rule ignores the query, so
 * `youtube.com/logout?v=<id>` or `laftel.net/player/1/2?next=...` would pass
 * every check above and still land members where the sender chose.
 */
export function followableUrl(
  url: string | undefined, roomKey: string, currentHref: string, reg: ProviderRegistry = builtinRegistry(),
): string | null {
  if (!url || !roomKey) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.hash) return null;
  if (normalizeMediaKey(u.href, reg) !== roomKey) return null;
  let here: URL | null = null;
  try { here = new URL(currentHref); } catch { /* no current site to compare */ }
  const e = entryFor(u.hostname, reg);
  const known = e !== null && reg.followable(e, u.hostname);
  const sameSite = here !== null && here.hostname.toLowerCase() === u.hostname.toLowerCase();
  if (!known && !sameSite) return null;
  // Never downgrade: a described provider is https, whatever the URL says.
  if (e && u.protocol !== 'https:') return null;
  const target = watchUrl(u.href, reg);
  if (!target || !e) return target;
  // The canonical host has to be followable too, not only the host the
  // sender named.
  const t = new URL(target);
  const sameTarget = here !== null && here.hostname.toLowerCase() === t.hostname.toLowerCase();
  return reg.followable(e, t.hostname) || sameTarget ? target : null;
}

export { evaluate };
