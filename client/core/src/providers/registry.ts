/**
 * The effective set of provider descriptors, and which one speaks for a host.
 *
 * Precedence per id is decided when a registry is built (`adoption.ts`):
 * user > adopted server (over a built-in only when the user confirmed it) >
 * built-in. Between different ids the more specific host wins, and a tie
 * applies neither -- two descriptors disagreeing about who a host is must not
 * be settled by load order, because two members could load them in different
 * orders and compute different keys.
 */
import { BUILTIN_SOURCES } from './builtin.gen.ts';
import { compileDescriptor, Provider } from './descriptor.ts';
import type { Tier } from './descriptor.ts';
import { normHost } from './template.ts';

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
  /** Descriptors that tied for this host; when non-empty, `entry` is null. */
  readonly conflict: readonly Entry[];
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
    const out: Lookup = tied.length === 1 ? { entry: tied[0]!, conflict: [] } : { entry: null, conflict: tied };
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

let builtinReg: ProviderRegistry | null = null;

export function builtinRegistry(): ProviderRegistry {
  builtinReg ??= new ProviderRegistry(builtinEntries());
  return builtinReg;
}

export { Provider };
