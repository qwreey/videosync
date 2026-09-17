/**
 * Which descriptors a user has taken on, and what a change to one would do.
 *
 * Platform-agnostic on purpose: the extension's options page, its content
 * script and the userscript's menu all decide the same things -- what is in
 * force, whether a server's copy differs from the one pinned, and whether a
 * change widens what the descriptor can do -- and they must decide them the
 * same way. Storage and fetching are the shims' business.
 */
import { builtinEntries, displacedBuiltins, ProviderRegistry } from './registry.ts';
import type { Entry } from './registry.ts';
import { coveredBy, parseDescriptor } from './descriptor.ts';
import type { Descriptor } from './descriptor.ts';

/** Store keys (under the shims' own `videosync.` prefix). */
export const STORE_KEYS = {
  /** JSON `StoredDescriptor[]`: written or imported by the user. */
  user: 'providers.user',
  /** JSON `AdoptedDescriptor[]`: taken on from a server, pinned by hash. */
  adopted: 'providers.adopted',
  /** JSON `Record<serverOrigin, ServerPrefs>`. */
  servers: 'providers.servers',
} as const;

export interface StoredDescriptor {
  /** The exact bytes, so the hash stays checkable. */
  source: string;
  sha256: string;
}

export interface AdoptedDescriptor extends StoredDescriptor {
  id: string;
  /** Origin of the server it came from. */
  server: string;
  /** The user saw the difference and chose this over the built-in with the same id. */
  replaceBuiltin: boolean;
}

export interface ServerPrefs {
  /** Take non-widening updates from this server without asking. Off unless chosen. */
  autoAdopt?: boolean;
  /** Offers the user said no to: id -> the hash they declined. */
  declined?: Record<string, string>;
}

export interface ProviderState {
  user: StoredDescriptor[];
  adopted: AdoptedDescriptor[];
  servers: Record<string, ServerPrefs>;
}

function parseJson<T>(raw: string, fallback: T, ok: (v: unknown) => boolean): T {
  if (!raw) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? v as T : fallback;
  } catch {
    return fallback;
  }
}

const isStored = (v: unknown): boolean =>
  typeof v === 'object' && v !== null &&
  typeof (v as StoredDescriptor).source === 'string' && typeof (v as StoredDescriptor).sha256 === 'string';

export function readState(load: (key: string, fallback?: string) => string): ProviderState {
  return {
    user: parseJson<StoredDescriptor[]>(load(STORE_KEYS.user, ''), [],
      (v) => Array.isArray(v) && v.every(isStored)),
    adopted: parseJson<AdoptedDescriptor[]>(load(STORE_KEYS.adopted, ''), [],
      (v) => Array.isArray(v) && v.every((x) => isStored(x) &&
        typeof (x as AdoptedDescriptor).id === 'string' && typeof (x as AdoptedDescriptor).server === 'string')),
    servers: parseJson<Record<string, ServerPrefs>>(load(STORE_KEYS.servers, ''), {},
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
  };
}

export function writeState(save: (key: string, value: string) => void, s: ProviderState): void {
  save(STORE_KEYS.user, JSON.stringify(s.user));
  save(STORE_KEYS.adopted, JSON.stringify(s.adopted));
  save(STORE_KEYS.servers, JSON.stringify(s.servers));
}

/** The origin a server is filed under: what the user typed, minus path noise. */
export function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return '';
  }
}

/**
 * The registry in force for this state. `granted` answers whether the user
 * has given the shim a host (extension: a runtime permission; userscript: an
 * `@match`); it decides followability for everything that is not built in.
 */
export function buildRegistry(s: ProviderState, granted: (hostname: string) => boolean): ProviderRegistry {
  const notes: string[] = [];
  const byId = new Map<string, Entry>();
  for (const b of builtinEntries()) byId.set(b.provider.id, b);
  const builtinIds = new Set(byId.keys());

  for (const a of s.adopted) {
    const r = parseDescriptor(a.source);
    if (!r.ok) { notes.push(`server descriptor ${a.id} from ${a.server} is no longer valid: ${r.errors[0]}`); continue; }
    if (r.provider.id !== a.id) { notes.push(`server descriptor ${a.id} from ${a.server} changed its id`); continue; }
    // Replacing a built-in is not only taking its id: a new id that claims
    // its hosts as specifically, or mints its key prefix, displaces it too.
    const displaced = displacedBuiltins(r.provider).map((b) => b.provider.id);
    if ((builtinIds.has(a.id) || displaced.length) && !a.replaceBuiltin) {
      notes.push(`server descriptor ${a.id} from ${a.server} is not applied: replacing the built-in${
        displaced.length ? ` (${displaced.join(', ')})` : ''} needs confirmation`);
      continue;
    }
    byId.set(a.id, { provider: r.provider, tier: 'server', sha256: a.sha256, granted });
  }
  for (const u of s.user) {
    const r = parseDescriptor(u.source);
    if (!r.ok) { notes.push(`a user descriptor is invalid: ${r.errors[0]}`); continue; }
    byId.set(r.provider.id, { provider: r.provider, tier: 'user', sha256: u.sha256, granted });
  }
  return new ProviderRegistry([...byId.values()], notes);
}

/** SHA-256 of the UTF-8 bytes, hex. Needs a secure context (or a worker, or node). */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('no crypto.subtle here (not a secure context)');
  const d = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// The server's index.

export interface IndexEntry {
  id: string;
  name: string;
  version: string;
  sha256: string;
  hosts: string[];
}

/** `GET /api/providers`. Malformed rows are dropped, not trusted. */
export function parseIndex(body: string): IndexEntry[] {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return []; }
  const list = (v as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is IndexEntry =>
    typeof e === 'object' && e !== null &&
    typeof e.id === 'string' && /^[a-z0-9-]{2,32}$/.test(e.id) &&
    typeof e.name === 'string' && typeof e.version === 'string' &&
    typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256) &&
    Array.isArray(e.hosts) && e.hosts.every((h: unknown) => typeof h === 'string'));
}

/** Adopted descriptors from `server` whose copy there has changed. */
export function pendingUpdates(s: ProviderState, server: string, index: readonly IndexEntry[]): IndexEntry[] {
  const origin = serverOrigin(server);
  return index.filter((e) => s.adopted.some((a) => a.server === origin && a.id === e.id && a.sha256 !== e.sha256));
}

/** What `server` offers that the user has neither taken on nor turned down. */
export function openOffers(s: ProviderState, server: string, index: readonly IndexEntry[]): IndexEntry[] {
  const origin = serverOrigin(server);
  const declined = s.servers[origin]?.declined ?? {};
  return index.filter((e) =>
    !s.adopted.some((a) => a.server === origin && a.id === e.id) && declined[e.id] !== e.sha256);
}

// ---------------------------------------------------------------------------
// What a change does.

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** Lets the descriptor claim, name or reach more than before. */
  widens: boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The differences a user is shown before a descriptor replaces another, and
 * whether each one widens anything. `before` null is a new descriptor, which
 * widens by definition.
 */
export function diffDescriptors(before: Descriptor | null, after: Descriptor): FieldChange[] {
  const out: FieldChange[] = [];
  const b = before;
  const add = (field: string, x: unknown, y: unknown, widens: boolean) => {
    if (!same(x, y)) out.push({ field, before: x, after: y, widens });
  };
  if (!b) {
    for (const f of ['hosts', 'pageHosts', 'canonicalHost', 'identity', 'pathFallback'] as const) {
      out.push({ field: f, before: undefined, after: after[f], widens: true });
    }
    return out;
  }
  // Any host that is not literally an old one widens, even one an old
  // wildcard covers: the registry picks by how specifically a host is
  // claimed, across ids and tiers, so `*.x` -> `www.x` raises the claim on
  // www.x and can tie or beat the user's own descriptor there.
  add('hosts', b.hosts, after.hosts, after.hosts.some((h) => !b.hosts.includes(h)));
  const pb = b.pageHosts ?? b.hosts;
  const pa = after.pageHosts ?? after.hosts;
  add('pageHosts', pb, pa, pa.some((h) => !coveredBy(h, pb)));
  add('canonicalHost', b.canonicalHost, after.canonicalHost, true);
  // A rule that is not literally one of the old ones may name pages the old
  // ones did not. Deciding "narrower" for templates in general is not worth
  // the code. Rules are first-match, so order is part of the key: a reorder,
  // or removing a rule that shadowed a later one, renames media that members
  // on the old pin still call by the old key. Dropping rules from the end is
  // the one plainly narrower change, and only when their pages get no key
  // at all rather than the generic rule's.
  const kept = after.identity.length <= b.identity.length &&
    after.identity.every((r, i) => same(r, b.identity[i])) &&
    (after.identity.length === b.identity.length || !after.pathFallback);
  add('identity', b.identity, after.identity, !kept);
  add('pathFallback', b.pathFallback, after.pathFallback, !b.pathFallback && after.pathFallback);
  add('keyPrefix', b.keyPrefix ?? b.id, after.keyPrefix ?? after.id, true);
  const cb = b.capabilities ?? {};
  const ca = after.capabilities ?? {};
  add('capabilities', cb, ca,
    (cb.playbackRateNudge === false && ca.playbackRateNudge !== false) ||
    (cb.directSeek === false && ca.directSeek !== false));
  add('continues', b.continues ?? [], after.continues ?? [],
    (after.continues ?? []).some((r) => !(b.continues ?? []).some((o) => same(o, r))));
  add('video', b.video ?? {}, after.video ?? {}, false);
  add('seek', b.seek ?? {}, after.seek ?? {}, false);
  add('requires', b.requires ?? [], after.requires ?? [], false);
  add('name', b.name, after.name, false);
  add('version', b.version, after.version, false);
  return out;
}

export function widens(before: Descriptor | null, after: Descriptor): boolean {
  return diffDescriptors(before, after).some((c) => c.widens);
}

/**
 * Whether a changed server copy may replace the pinned one unasked: only with
 * auto-adopt on for that server, and only when nothing widens.
 */
export function mayAutoAdopt(s: ProviderState, server: string, before: Descriptor, after: Descriptor): boolean {
  return s.servers[serverOrigin(server)]?.autoAdopt === true && before.id === after.id && !widens(before, after);
}
