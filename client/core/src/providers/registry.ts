/**
 * The effective set of provider descriptors, and which one speaks for a host.
 *
 * Precedence per id is decided when a registry is built (`adoption.ts`):
 * user > adopted server (over a built-in only when the user confirmed it) >
 * built-in. Between different ids the more specific host wins, and a tie
 * applies neither -- two descriptors disagreeing about who a host is must not
 * be settled by load order, because two members could load them in different
 * orders and compute different keys.
 *
 * "Neither" does not mean the generic path rule on a host a built-in
 * describes, though: that rule names every path as media, which is F20 back
 * on exactly the sites whose descriptors closed it. There the built-in in
 * force applies, or, when it was replaced, nothing does.
 */
import { BUILTIN_SOURCES } from './builtin.gen.ts';
import { compileDescriptor, Provider } from './descriptor.ts';
import type { Tier } from './descriptor.ts';
import { hostScore, normHost } from './template.ts';

export interface Entry {
  readonly provider: Provider;
  readonly tier: Tier;
  /** Of the exact bytes it was compiled from. */
  readonly sha256: string;
  /**
   * For a server or user descriptor: whether the user has granted this host
   * (extension) or matched it (userscript). A descriptor someone else wrote
   * never makes a host followable on its own say-so -- otherwise a server
   * could name any site and have every room member sent there.
   */
  readonly granted?: (hostname: string) => boolean;
}

export interface Lookup {
  /** The descriptor in force, or null for the generic path rule. */
  readonly entry: Entry | null;
  /**
   * Descriptors that tied for this host. When non-empty, `entry` is the
   * built-in in force for the host if there is one, else null.
   */
  readonly conflict: readonly Entry[];
  /**
   * The host names no media at all: a tie on a host a compiled-in built-in
   * describes, with that built-in not in force. The generic path rule must
   * not stand in there.
   */
  readonly blocked?: boolean;
}

export class ProviderRegistry {
  readonly entries: readonly Entry[];
  /** Why something offered was not applied. Surfaced by `dump()`. */
  readonly notes: readonly string[];
  private readonly cache = new Map<string, Lookup>();

  constructor(entries: readonly Entry[], notes: readonly string[] = []) {
    this.entries = entries;
    this.notes = notes;
  }

  lookup(hostname: string): Lookup {
    const h = normHost(hostname);
    const hit = this.cache.get(h);
    if (hit) return hit;
    let best = 0;
    let tied: Entry[] = [];
    for (const e of this.entries) {
      const s = e.provider.claims(h);
      if (s === 0 || s < best) continue;
      if (s > best) { best = s; tied = [e]; } else tied.push(e);
    }
    let out: Lookup;
    if (tied.length === 1) out = { entry: tied[0]!, conflict: [] };
    else if (tied.length === 0) {
      // Nobody claims it. On a host a compiled-in built-in describes, whose
      // id is taken by a descriptor that no longer claims the host (N10),
      // the generic rule there is F20 again.
      const replaced = builtinEntries().some((b) => b.provider.claims(h) > 0 &&
        this.entries.some((e) => e.tier !== 'built-in' && e.provider.id === b.provider.id));
      out = { entry: null, conflict: [], ...(replaced ? { blocked: true } : {}) };
    }
    else {
      let bi: Entry | null = null;
      let biScore = 0;
      let biTie = false;
      for (const e of this.entries) {
        if (e.tier !== 'built-in') continue;
        const sc = e.provider.claims(h);
        if (sc > biScore) { bi = e; biScore = sc; biTie = false; } else if (sc > 0 && sc === biScore) biTie = true;
      }
      if (bi && !biTie) out = { entry: bi, conflict: tied };
      else {
        const described = bi !== null || builtinEntries().some((b) => b.provider.claims(h) > 0);
        out = { entry: null, conflict: tied, ...(described ? { blocked: true } : {}) };
      }
    }
    if (this.cache.size > 256) this.cache.clear();
    this.cache.set(h, out);
    return out;
  }

  byId(id: string): Entry | null {
    return this.entries.find((e) => e.provider.id === id) ?? null;
  }

  /** Whether following into `hostname` is allowed by the entry in force. */
  followable(e: Entry, hostname: string): boolean {
    if (e.tier === 'built-in') return true;
    return e.granted?.(normHost(hostname)) ?? false;
  }
}

let builtins: readonly Entry[] | null = null;

/**
 * The descriptors compiled into this bundle. A built-in that fails to compile
 * is a build error that CI catches (providers.test.ts); at run time it is
 * left out rather than taking the whole client down.
 */
export function builtinEntries(): readonly Entry[] {
  if (builtins) return builtins;
  const out: Entry[] = [];
  for (const b of BUILTIN_SOURCES) {
    const r = compileDescriptor(JSON.parse(b.source));
    if (r.ok) out.push({ provider: r.provider, tier: 'built-in', sha256: b.sha256 });
  }
  builtins = out;
  return out;
}

/**
 * The built-ins a descriptor with another id would take something from if it
 * were applied: a host a built-in describes, claimed at least as specifically
 * (so it wins, or ties), or the built-in's key prefix (so it mints keys in a
 * namespace that is frozen on the wire). Taking either is replacing the
 * built-in, and needs the same explicit confirmation as replacing it by id.
 */
export function displacedBuiltins(p: Provider): Entry[] {
  const out: Entry[] = [];
  for (const b of builtinEntries()) {
    if (b.provider.id === p.id) continue;
    let takes = b.provider.keyPrefix === p.keyPrefix;
    for (const dh of p.hosts) {
      if (takes) break;
      // A wildcard is tried on a label nobody has, below its base.
      const probe = dh.startsWith('*.') ? `vs-probe-label.${dh.slice(2)}` : dh;
      const bs = b.provider.claims(probe);
      takes = bs > 0 && hostScore(dh, probe) >= bs;
    }
    if (takes) out.push(b);
  }
  return out;
}

let builtinReg: ProviderRegistry | null = null;

export function builtinRegistry(): ProviderRegistry {
  builtinReg ??= new ProviderRegistry(builtinEntries());
  return builtinReg;
}

export { Provider };
