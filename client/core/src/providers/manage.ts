/**
 * What the user can do with descriptors, as pure state transitions.
 *
 * The extension's options page and the userscript's menu are thin surfaces
 * over these, so the rules -- a server copy must hash to what the index said,
 * replacing a built-in needs an explicit yes, an automatic update may widen
 * nothing -- are written, and tested, once.
 */
import {
  diffDescriptors, mayAutoAdopt, pendingUpdates, serverOrigin, sha256Hex, STORE_KEYS,
} from './adoption.ts';
import type { FieldChange, IndexEntry, ProviderState } from './adoption.ts';
import { parseDescriptor } from './descriptor.ts';
import type { Descriptor } from './descriptor.ts';
import { builtinEntries, displacedBuiltins } from './registry.ts';
import type { ProviderRegistry } from './registry.ts';
import { hostScore } from './template.ts';

export type Outcome =
  | {
    ok: true; state: ProviderState; descriptor: Descriptor; changes: FieldChange[];
    /** Built-ins (names) this descriptor takes a host or the key prefix from; see `displacedBuiltins`. */
    displaces?: string[];
  }
  | { ok: false; error: string; needsReplaceConfirmation?: boolean; changes?: FieldChange[] };

const clone = (s: ProviderState): ProviderState => structuredClone(s);

function builtinDescriptor(id: string): Descriptor | null {
  return builtinEntries().find((e) => e.provider.id === id)?.provider.d ?? null;
}

/** What is in force for `id` now, before the change: user > adopted > built-in. */
export function currentFor(s: ProviderState, id: string): Descriptor | null {
  for (const u of s.user) {
    const r = parseDescriptor(u.source);
    if (r.ok && r.provider.id === id) return r.provider.d;
  }
  const a = s.adopted.find((x) => x.id === id);
  if (a) {
    const r = parseDescriptor(a.source);
    if (r.ok && (a.replaceBuiltin || !builtinDescriptor(id))) return r.provider.d;
  }
  return builtinDescriptor(id);
}

/** Add or replace (by id) a descriptor the user wrote or imported. */
export async function saveUser(s: ProviderState, text: string): Promise<Outcome> {
  const r = parseDescriptor(text);
  if (!r.ok) return { ok: false, error: r.errors.join('\n') };
  const d = r.provider.d;
  const changes = diffDescriptors(currentFor(s, d.id), d);
  const next = clone(s);
  const keep = [];
  for (const u of next.user) {
    const x = parseDescriptor(u.source);
    if (!(x.ok && x.provider.id === d.id)) keep.push(u);
  }
  keep.push({ source: text, sha256: await sha256Hex(text) });
  next.user = keep;
  // The user's own descriptor may displace a built-in (user is the top tier),
  // but a surface must say so before saving, not only show a new id.
  const displaces = displacedBuiltins(r.provider).map((b) => b.provider.d.name);
  return { ok: true, state: next, descriptor: d, changes, ...(displaces.length ? { displaces } : {}) };
}

export function removeUser(s: ProviderState, id: string): ProviderState {
  const next = clone(s);
  next.user = next.user.filter((u) => {
    const x = parseDescriptor(u.source);
    return !(x.ok && x.provider.id === id);
  });
  return next;
}

/**
 * Take on `entry` from `server`, whose file is `body`. The hash is checked
 * against the index the user looked at, so what they reviewed is what they
 * pin. Replacing a built-in is refused until `replaceBuiltin` says the user
 * saw the difference.
 */
export async function adopt(
  s: ProviderState, server: string, entry: IndexEntry, body: string, replaceBuiltin: boolean,
): Promise<Outcome> {
  const origin = serverOrigin(server);
  if (!origin) return { ok: false, error: '서버 주소가 올바르지 않아요.' };
  const sha = await sha256Hex(body);
  if (sha !== entry.sha256) return { ok: false, error: '서버가 목록과 다른 파일을 보냈어요 (해시 불일치).' };
  const r = parseDescriptor(body);
  if (!r.ok) return { ok: false, error: r.errors.join('\n') };
  const d = r.provider.d;
  if (d.id !== entry.id) return { ok: false, error: `파일의 id(${d.id})가 목록(${entry.id})과 달라요.` };
  const changes = diffDescriptors(currentFor(s, d.id), d);
  const builtin = builtinDescriptor(d.id);
  // Not only by id: a new id that claims a built-in's host as specifically,
  // or its key prefix, replaces it just the same (buildRegistry agrees).
  const displaced = displacedBuiltins(r.provider).map((b) => b.provider.d.name);
  const replaced = [...(builtin ? [builtin.name] : []), ...displaced];
  if (replaced.length && !replaceBuiltin) {
    return {
      ok: false, needsReplaceConfirmation: true, changes,
      error: `내장된 ${replaced.join(', ')} 설명을 바꾸게 돼요. 차이를 확인한 뒤 교체를 선택하세요.`,
    };
  }
  const next = clone(s);
  next.adopted = next.adopted.filter((a) => a.id !== d.id);
  next.adopted.push({ id: d.id, server: origin, source: body, sha256: sha, replaceBuiltin: replaced.length > 0 });
  const prefs = next.servers[origin];
  if (prefs?.declined) delete prefs.declined[d.id];
  return { ok: true, state: next, descriptor: d, changes };
}

export function unadopt(s: ProviderState, id: string): ProviderState {
  const next = clone(s);
  next.adopted = next.adopted.filter((a) => a.id !== id);
  return next;
}

/** "Not this one": the offer stays quiet until the server's copy changes. */
export function decline(s: ProviderState, server: string, entry: IndexEntry): ProviderState {
  const next = clone(s);
  const origin = serverOrigin(server);
  const prefs = (next.servers[origin] ??= {});
  (prefs.declined ??= {})[entry.id] = entry.sha256;
  return next;
}

export function setAutoAdopt(s: ProviderState, server: string, on: boolean): ProviderState {
  const next = clone(s);
  (next.servers[serverOrigin(server)] ??= {}).autoAdopt = on;
  return next;
}

/**
 * Apply what may be applied without asking, and return what still needs the
 * user. Only with auto-adopt on for this server; only a file that hashes to
 * what the index says; only a change that widens nothing.
 */
export async function autoUpdate(
  s: ProviderState, server: string, index: readonly IndexEntry[], fetchBody: (id: string) => Promise<string>,
): Promise<{ state: ProviderState; applied: string[]; pending: IndexEntry[] }> {
  let state = s;
  const applied: string[] = [];
  const pending: IndexEntry[] = [];
  const origin = serverOrigin(server);
  for (const e of pendingUpdates(s, server, index)) {
    const pinned = state.adopted.find((a) => a.id === e.id && a.server === origin);
    const before = pinned && parseDescriptor(pinned.source);
    if (!pinned || !before?.ok || state.servers[origin]?.autoAdopt !== true) { pending.push(e); continue; }
    try {
      const body = await fetchBody(e.id);
      const after = parseDescriptor(body);
      if ((await sha256Hex(body)) !== e.sha256 || !after.ok ||
          !mayAutoAdopt(state, server, before.provider.d, after.provider.d)) {
        pending.push(e);
        continue;
      }
      state = clone(state);
      state.adopted = state.adopted.map((a) => (a === pinned || (a.id === e.id && a.server === origin)
        ? { ...a, source: body, sha256: e.sha256 } : a));
      applied.push(e.id);
    } catch {
      pending.push(e);
    }
  }
  return { state, applied, pending };
}

/** The origins to ask the browser for, so the descriptor's hosts are followable and its pages injected. */
export function originsFor(d: Descriptor): string[] {
  const out: string[] = [];
  for (const h of [...d.hosts, ...(d.pageHosts ?? [])]) {
    const o = `https://${h}/*`;
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * A host test from granted match patterns (`https://*.example.com/*`,
 * `https://example.com/*`, `<all_urls>`). A `*.` pattern covers the bare
 * domain too, as a browser match pattern does.
 */
export function grantedBy(origins: readonly string[]): (hostname: string) => boolean {
  const hosts: string[] = [];
  let all = false;
  for (const o of origins) {
    if (o === '<all_urls>') { all = true; continue; }
    const m = /^(?:\*|https?):\/\/([^/]+)\//.exec(o);
    if (!m) continue;
    if (m[1] === '*') all = true;
    else hosts.push(m[1]!.toLowerCase());
  }
  return (hostname) => all || hosts.some((p) =>
    hostScore(p, hostname) > 0 || (p.startsWith('*.') && hostScore(p.slice(2), hostname) > 0));
}

/**
 * Match patterns for the pages of every descriptor that is not built in and
 * whose pages the user granted: what the extension registers its content
 * script for at run time. The built-ins are in the manifest already.
 */
export function dynamicPagePatterns(reg: ProviderRegistry, granted: (hostname: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of reg.entries) {
    if (e.tier === 'built-in') continue;
    for (const h of e.provider.pageHosts) {
      const probe = h.startsWith('*.') ? h.slice(2) : h;
      if (!granted(probe)) continue;
      const p = `https://${h}/*`;
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * The `@match` lines a userscript still needs for a descriptor's pages. A
 * userscript cannot add sites to itself; the user has to, and this says
 * exactly what to add.
 */
export function missingMatches(d: Descriptor, matches: readonly string[]): string[] {
  const has = grantedBy(matches);
  return (d.pageHosts ?? d.hosts)
    .filter((h) => !has(h.startsWith('*.') ? `x.${h.slice(2)}` : h))
    .map((h) => `// @match        https://${h}/*`);
}

/**
 * `autoUpdate` against stored state that other places change meanwhile (the
 * options page, the userscript menu, another tab), and write back only what
 * it applied.
 *
 * The index and the files are fetched between reading the state and writing
 * it, and whatever the user did in that time wins: a pin that was dropped or
 * changed, or auto-adopt turned off, is left alone. Only the `adopted` key is
 * written -- rewriting the user's own descriptors and the server preferences
 * from the copy read before the fetch would undo a deletion made in between.
 * `read` must return the state as stored now, each time it is called.
 */
export async function autoUpdateStored(
  read: () => ProviderState | Promise<ProviderState>,
  save: (key: string, value: string) => void,
  server: string, index: readonly IndexEntry[], fetchBody: (id: string) => Promise<string>,
): Promise<IndexEntry[]> {
  const before = await read();
  const r = await autoUpdate(before, server, index, fetchBody);
  if (!r.applied.length) return r.pending;
  const origin = serverOrigin(server);
  const now = await read();
  const pending = [...r.pending];
  let adopted = now.adopted;
  let changed = false;
  for (const id of r.applied) {
    const was = before.adopted.find((a) => a.id === id && a.server === origin);
    const got = r.state.adopted.find((a) => a.id === id && a.server === origin);
    const cur = now.adopted.find((a) => a.id === id && a.server === origin);
    if (!was || !got || !cur) continue; // unadopted meanwhile: nothing to update, nothing to offer
    if (cur.sha256 !== was.sha256 || cur.source !== was.source || now.servers[origin]?.autoAdopt !== true) {
      const e = index.find((x) => x.id === id);
      if (e && cur.sha256 !== e.sha256) pending.push(e);
      continue;
    }
    adopted = adopted.map((a) => (a === cur ? { ...a, source: got.source, sha256: got.sha256 } : a));
    changed = true;
  }
  if (changed) save(STORE_KEYS.adopted, JSON.stringify(adopted));
  return pending;
}
