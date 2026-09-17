/**
 * Provider descriptors, schema 1 (docs/design/providers.md, D7).
 *
 * A descriptor is data that bundled code evaluates: it selects and tunes, it
 * never runs anything. That is what keeps the MV3 remote-code ban intact while
 * a server hands them out, and it is why every field here is checked against a
 * closed list -- an unknown field is refused rather than ignored, because a
 * field we ignore might be a restriction its author relied on (`requires`
 * exists for the same reason).
 *
 * The Go port (server/internal/provider) validates the same way; the shared
 * vectors in providers/testdata/ keep the two honest.
 */
import {
  bestHostScore, LIMITS, matchPath, matchQuery, normHost, parsePathTemplate, parseQueryTemplate,
  parseTextTemplate, substitute, validHostPattern, aceLabel,
} from './template.ts';
import type { Captures, PathTemplate, QueryTemplate, TextTemplate } from './template.ts';

export const SCHEMA = 1;
export const MAX_BYTES = 16 * 1024;
export const MAX_RULES = 32;
export const MAX_HOSTS = 32;
export const MAX_SELECTORS = 16;
export const MAX_SELECTOR_LEN = 256;
export const MAX_EXAMPLES = 64;
export const MAX_CONTINUES = 8;
export const ADAPTERS = ['html5'] as const;

/**
 * Field names a descriptor may list in `requires`: the ones this client
 * actually honours. `ads` and `navigation` are accepted but not acted on yet,
 * so a descriptor that depends on them is refused rather than half-applied.
 */
export const IMPLEMENTED = [
  'hosts', 'pageHosts', 'canonicalHost', 'identity', 'identity.hosts', 'identity.query', 'pathFallback',
  'video', 'video.include', 'video.exclude', 'video.pierceShadow', 'video.minIntrinsicArea',
  'video.outclassedFactor', 'capabilities', 'capabilities.playbackRateNudge', 'capabilities.directSeek',
  'seek', 'seek.landingToleranceS', 'seek.timeoutMs', 'continues',
] as const;

export interface IdentityRule {
  hosts?: string[];
  path: string;
  query?: Record<string, string>;
  key: string;
  watch: string;
}

export interface VideoHints {
  include?: string[];
  exclude?: string[];
  pierceShadow?: boolean;
  minIntrinsicArea?: number;
  outclassedFactor?: number;
}

export interface CapabilityMask {
  playbackRateNudge?: boolean;
  directSeek?: boolean;
}

export interface SeekHints {
  landingToleranceS?: number;
  timeoutMs?: number;
  typicalInBufferMs?: number;
}

export type Example =
  | { url: string; key: string | null; watch?: string | null }
  | { from: string; to: string; continues: boolean };

export interface Descriptor {
  schema: number;
  requires?: string[];
  id: string;
  keyPrefix?: string;
  name: string;
  version: string;
  adapter: string;
  hosts: string[];
  pageHosts?: string[];
  canonicalHost: string;
  identity: IdentityRule[];
  pathFallback: boolean;
  video?: VideoHints;
  ads?: { activeWhen?: string[] };
  capabilities?: CapabilityMask;
  seek?: SeekHints;
  navigation?: { spa?: boolean; volatileElement?: boolean; siteAutoplaysNext?: boolean | null };
  continues?: Array<{ from: string; to: string }>;
  examples: Example[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Structural validation. Written against `unknown` so nothing is trusted
// before it is checked, and so the Go port can follow it line by line.

type Obj = Record<string, unknown>;

class Problems {
  readonly list: string[] = [];
  add(msg: string): void { if (this.list.length < 32) this.list.push(msg); }
}

/** Lengths are code points, as Go counts runes: the two ports must agree. */
const cpLen = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(o: Obj, allowed: readonly string[], where: string, p: Problems): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) p.add(`${where}: unknown field "${k}"`);
}

function str(o: Obj, k: string, where: string, p: Problems, opt: { optional?: boolean; max?: number; re?: RegExp } = {}): string | undefined {
  const v = o[k];
  if (v === undefined) {
    if (!opt.optional) p.add(`${where}: "${k}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') { p.add(`${where}: "${k}" must be a string`); return undefined; }
  if (opt.max !== undefined && cpLen(v) > opt.max) { p.add(`${where}: "${k}" is longer than ${opt.max}`); return undefined; }
  if (opt.re && !opt.re.test(v)) { p.add(`${where}: "${k}" is malformed`); return undefined; }
  return v;
}

function bool(o: Obj, k: string, where: string, p: Problems, optional = true): boolean | undefined {
  const v = o[k];
  if (v === undefined) {
    if (!optional) p.add(`${where}: "${k}" is required`);
    return undefined;
  }
  if (typeof v !== 'boolean') { p.add(`${where}: "${k}" must be true or false`); return undefined; }
  return v;
}

function num(o: Obj, k: string, where: string, p: Problems, min: number, max: number, int: boolean): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || (int && !Number.isInteger(v)) || v < min || v > max) {
    p.add(`${where}: "${k}" must be ${int ? 'an integer' : 'a number'} in [${min}, ${max}]`);
    return undefined;
  }
  return v;
}

function strList(o: Obj, k: string, where: string, p: Problems, max: number, optional = true): string[] | undefined {
  const v = o[k];
  if (v === undefined) {
    if (!optional) p.add(`${where}: "${k}" is required`);
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    p.add(`${where}: "${k}" must be a list of strings`);
    return undefined;
  }
  if (v.length > max) { p.add(`${where}: "${k}" has more than ${max} entries`); return undefined; }
  return v as string[];
}

function selectors(o: Obj, k: string, where: string, p: Problems): void {
  const list = strList(o, k, where, p, MAX_SELECTORS);
  for (const s of list ?? []) {
    if (s === '' || cpLen(s) > MAX_SELECTOR_LEN) p.add(`${where}.${k}: a selector must be 1..${MAX_SELECTOR_LEN} characters`);
    // CSS decodes escapes and drops comments before it forms a function
    // token, so `:\has(` and `:/**/has(` are :has( to the engine. Refusing
    // what could spell it differently is the only check that needs no
    // tokenizer; control characters go with them (a newline ends an escape).
    else if (/[\\\u0000-\u001f\u007f-\u009f]|\/\*/.test(s)) {
      p.add(`${where}.${k}: a selector must not contain a backslash, "/*" or a control character`);
    }
    // The one selector feature whose cost grows with the whole document, run
    // on every mutation of a page that may be a feed of thousands of nodes.
    else if (s.toLowerCase().includes(':has(')) p.add(`${where}.${k}: ":has(" is not allowed`);
  }
}

const ID = /^[a-z0-9-]{2,32}$/;
const KEY_PREFIX = /^[a-z0-9.-]{2,64}$/;
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

const TOP = [
  'schema', 'requires', 'id', 'keyPrefix', 'name', 'version', 'adapter', 'hosts', 'pageHosts',
  'canonicalHost', 'identity', 'pathFallback', 'video', 'ads', 'capabilities', 'seek', 'navigation',
  'continues', 'examples', 'notes',
];

function checkStructure(v: unknown, p: Problems): void {
  if (!isObj(v)) { p.add('descriptor: must be a JSON object'); return; }
  const w = 'descriptor';
  // Schema first: a newer schema is refused as a whole, not field by field.
  if (typeof v.schema !== 'number' || !Number.isInteger(v.schema) || v.schema < 1) {
    p.add(`${w}: "schema" must be a positive integer`);
    return;
  }
  if (v.schema > SCHEMA) { p.add(`${w}: schema ${v.schema} is newer than this client understands (${SCHEMA})`); return; }
  onlyKeys(v, TOP, w, p);
  const req = strList(v, 'requires', w, p, 16);
  for (const r of req ?? []) {
    if (!(IMPLEMENTED as readonly string[]).includes(r)) p.add(`${w}: requires "${r}", which this client does not implement`);
  }
  str(v, 'id', w, p, { re: ID });
  str(v, 'keyPrefix', w, p, { optional: true, re: KEY_PREFIX });
  str(v, 'name', w, p, { max: 64 });
  str(v, 'version', w, p, { re: VERSION });
  const adapter = str(v, 'adapter', w, p);
  if (adapter !== undefined && !(ADAPTERS as readonly string[]).includes(adapter)) p.add(`${w}: unknown adapter "${adapter}"`);
  const hosts = strList(v, 'hosts', w, p, MAX_HOSTS, false);
  if (hosts && hosts.length === 0) p.add(`${w}: "hosts" is empty`);
  for (const h of hosts ?? []) if (!validHostPattern(h)) p.add(`${w}: bad host "${h}"`);
  const page = strList(v, 'pageHosts', w, p, MAX_HOSTS);
  for (const h of page ?? []) {
    if (!validHostPattern(h)) p.add(`${w}: bad page host "${h}"`);
    else if (hosts && !coveredBy(h, hosts)) p.add(`${w}: page host "${h}" is not in "hosts"`);
  }
  const canon = str(v, 'canonicalHost', w, p);
  if (canon !== undefined) {
    // The generic rule's watch URL is built on it, so it must read alike in both ports.
    if (canon.startsWith('*.') || !validHostPattern(canon) || !plainHost(canon)) p.add(`${w}: bad canonicalHost "${canon}"`);
    else if (hosts && !coveredBy(canon, hosts)) p.add(`${w}: canonicalHost "${canon}" is not in "hosts"`);
  }
  bool(v, 'pathFallback', w, p, false);

  if (!Array.isArray(v.identity)) p.add(`${w}: "identity" must be a list`);
  else {
    if (v.identity.length > MAX_RULES) p.add(`${w}: more than ${MAX_RULES} identity rules`);
    v.identity.forEach((r, i) => {
      const rw = `identity[${i}]`;
      if (!isObj(r)) { p.add(`${rw}: must be an object`); return; }
      onlyKeys(r, ['hosts', 'path', 'query', 'key', 'watch'], rw, p);
      const rh = strList(r, 'hosts', rw, p, MAX_HOSTS);
      for (const h of rh ?? []) {
        if (!validHostPattern(h)) p.add(`${rw}: bad host "${h}"`);
        else if (hosts && !coveredBy(h, hosts)) p.add(`${rw}: host "${h}" is not in "hosts"`);
      }
      str(r, 'path', rw, p);
      str(r, 'key', rw, p);
      str(r, 'watch', rw, p);
      if (r.query !== undefined && !isObj(r.query)) p.add(`${rw}: "query" must be an object`);
    });
  }

  if (v.video !== undefined) {
    if (!isObj(v.video)) p.add(`${w}: "video" must be an object`);
    else {
      const vw = 'video';
      onlyKeys(v.video, ['include', 'exclude', 'pierceShadow', 'minIntrinsicArea', 'outclassedFactor'], vw, p);
      selectors(v.video, 'include', vw, p);
      selectors(v.video, 'exclude', vw, p);
      bool(v.video, 'pierceShadow', vw, p);
      num(v.video, 'minIntrinsicArea', vw, p, 0, 7680 * 4320, true);
      num(v.video, 'outclassedFactor', vw, p, 1.5, 16, false);
    }
  }
  if (v.ads !== undefined) {
    if (!isObj(v.ads)) p.add(`${w}: "ads" must be an object`);
    else {
      onlyKeys(v.ads, ['activeWhen'], 'ads', p);
      selectors(v.ads, 'activeWhen', 'ads', p);
    }
  }
  if (v.capabilities !== undefined) {
    if (!isObj(v.capabilities)) p.add(`${w}: "capabilities" must be an object`);
    else {
      onlyKeys(v.capabilities, ['playbackRateNudge', 'directSeek'], 'capabilities', p);
      bool(v.capabilities, 'playbackRateNudge', 'capabilities', p);
      bool(v.capabilities, 'directSeek', 'capabilities', p);
    }
  }
  if (v.seek !== undefined) {
    if (!isObj(v.seek)) p.add(`${w}: "seek" must be an object`);
    else {
      onlyKeys(v.seek, ['landingToleranceS', 'timeoutMs', 'typicalInBufferMs'], 'seek', p);
      num(v.seek, 'landingToleranceS', 'seek', p, 0.05, 5, false);
      num(v.seek, 'timeoutMs', 'seek', p, 1000, 60000, true);
      num(v.seek, 'typicalInBufferMs', 'seek', p, 0, 60000, true);
    }
  }
  if (v.navigation !== undefined) {
    if (!isObj(v.navigation)) p.add(`${w}: "navigation" must be an object`);
    else {
      onlyKeys(v.navigation, ['spa', 'volatileElement', 'siteAutoplaysNext'], 'navigation', p);
      bool(v.navigation, 'spa', 'navigation', p);
      bool(v.navigation, 'volatileElement', 'navigation', p);
      if (v.navigation.siteAutoplaysNext !== null) bool(v.navigation, 'siteAutoplaysNext', 'navigation', p);
    }
  }
  if (v.continues !== undefined) {
    if (!Array.isArray(v.continues)) p.add(`${w}: "continues" must be a list`);
    else {
      if (v.continues.length > MAX_CONTINUES) p.add(`${w}: more than ${MAX_CONTINUES} continues rules`);
      v.continues.forEach((c, i) => {
        const cw = `continues[${i}]`;
        if (!isObj(c)) { p.add(`${cw}: must be an object`); return; }
        onlyKeys(c, ['from', 'to'], cw, p);
        str(c, 'from', cw, p);
        str(c, 'to', cw, p);
      });
    }
  }
  if (!Array.isArray(v.examples)) p.add(`${w}: "examples" must be a list`);
  else {
    if (v.examples.length > MAX_EXAMPLES) p.add(`${w}: more than ${MAX_EXAMPLES} examples`);
    v.examples.forEach((e, i) => {
      const ew = `examples[${i}]`;
      if (!isObj(e)) { p.add(`${ew}: must be an object`); return; }
      if ('url' in e) {
        onlyKeys(e, ['url', 'key', 'watch'], ew, p);
        str(e, 'url', ew, p, { max: 2048 });
        if (!('key' in e)) p.add(`${ew}: "key" is required (null for "names no media")`);
        else if (e.key !== null) str(e, 'key', ew, p);
        if (e.watch !== undefined && e.watch !== null) str(e, 'watch', ew, p);
      } else {
        onlyKeys(e, ['from', 'to', 'continues'], ew, p);
        str(e, 'from', ew, p);
        str(e, 'to', ew, p);
        bool(e, 'continues', ew, p, false);
      }
    });
  }
  str(v, 'notes', w, p, { optional: true, max: 2048 });
}

/** Whether `host` (itself a pattern) is claimed by one of `patterns`. */
export function coveredBy(host: string, patterns: readonly string[]): boolean {
  if (patterns.includes(host)) return true;
  // A wildcard is covered only by a wildcard over the same or a shorter base.
  const probe = host.startsWith('*.') ? `x.${host.slice(2)}` : host;
  return patterns.some((p) => p.startsWith('*.') && bestHostScore([p], probe) > 0);
}

// ---------------------------------------------------------------------------
// Compiled form.

interface CompiledRule {
  hosts: readonly string[] | null;
  path: PathTemplate;
  query: QueryTemplate | null;
  key: TextTemplate;
  watch: TextTemplate;
}

interface CompiledContinues {
  from: PathTemplate;
  to: PathTemplate;
}

export type Tier = 'built-in' | 'server' | 'user';

/** A descriptor that passed validation, ready to evaluate. Immutable. */
export class Provider {
  readonly d: Descriptor;
  readonly id: string;
  readonly keyPrefix: string;
  private readonly rules: readonly CompiledRule[];
  private readonly cont: readonly CompiledContinues[];

  /** Use `compileDescriptor`; this assumes `d` is structurally valid. */
  constructor(d: Descriptor) {
    this.d = d;
    this.id = d.id;
    this.keyPrefix = d.keyPrefix ?? d.id;
    this.rules = d.identity.map((r, i) => {
      const where = `identity[${i}]`;
      const path = wrap(where, () => parsePathTemplate(r.path));
      const query = r.query === undefined ? null : wrap(where, () => parseQueryTemplate(r.query, path.names));
      const names = [...path.names, ...(query?.names ?? [])];
      const key = wrap(`${where}.key`, () => parseTextTemplate(r.key, names, LIMITS.keyTemplateLen));
      const watch = wrap(`${where}.watch`, () => parseTextTemplate(r.watch, names, LIMITS.watchTemplateLen));
      checkWatchTemplate(r.watch, d, where);
      // A rule that names every path of a host as media is F20 again.
      if (!query && path.segments.length === 1 && path.segments[0]!.t === 'rest') {
        throw new Error(`${where}: "/**" with no query would name every page as media`);
      }
      return { hosts: r.hosts ?? null, path, query, key, watch };
    });
    this.cont = (d.continues ?? []).map((c, i) => ({
      from: wrap(`continues[${i}].from`, () => parsePathTemplate(c.from)),
      to: wrap(`continues[${i}].to`, () => parsePathTemplate(c.to)),
    }));
  }

  get hosts(): readonly string[] { return this.d.hosts; }
  get pageHosts(): readonly string[] { return this.d.pageHosts ?? this.d.hosts; }

  /** How specifically this descriptor claims `hostname`; 0 if not at all. */
  claims(hostname: string): number {
    return bestHostScore(this.d.hosts, hostname);
  }

  /**
   * The key for `u`, which must be on a claimed host: `prefix:body`, or null
   * for a page that names no media.
   */
  keyFor(u: URL): string | null {
    const m = this.match(u);
    if (m) return `${this.keyPrefix}:${substitute(m.rule.key, m.caps, false)}`;
    if (!this.d.pathFallback) return null;
    const path = genericPath(u);
    return path ? `${this.keyPrefix}:${path}` : null;
  }

  /** The canonical page for `u`'s media, before the round-trip check. */
  rawWatchFor(u: URL): string | null {
    const m = this.match(u);
    if (m) return substitute(m.rule.watch, m.caps, true);
    if (!this.d.pathFallback) return null;
    const path = genericPath(u);
    return path ? `https://${this.d.canonicalHost}${path}` : null;
  }

  private match(u: URL): { rule: CompiledRule; caps: Captures } | null {
    for (const rule of this.rules) {
      if (rule.hosts && bestHostScore(rule.hosts, u.hostname) === 0) continue;
      const caps = matchPath(rule.path, u.pathname);
      if (!caps) continue;
      if (rule.query) {
        const q = matchQuery(rule.query, u.search);
        if (!q) continue;
        Object.assign(caps, q);
      }
      return { rule, caps };
    }
    return null;
  }

  /**
   * Whether media `next` carries on from `prev` (Laftel: the same series).
   * Informational until D8 consumes it. Captures with the same name in `from`
   * and `to` must be equal; the same key is not a continuation of itself.
   */
  continues(prev: string, next: string): boolean {
    const pre = `${this.keyPrefix}:`;
    // Judged as Go and the wire read them: a lone surrogate is U+FFFD (N21),
    // so keys that differ only there are the same key.
    const p = wellFormed(prev) as string;
    const n = wellFormed(next) as string;
    if (!p.startsWith(pre) || !n.startsWith(pre) || p === n) return false;
    const a = p.slice(pre.length);
    const b = n.slice(pre.length);
    for (const c of this.cont) {
      const ca = matchBody(c.from, a);
      const cb = ca && matchBody(c.to, b);
      if (!ca || !cb) continue;
      // Own keys only: a capture may be named `constructor` or `toString`, and
      // `in` would find those on Object.prototype where Go's map finds nothing.
      if (Object.keys(ca).every((k) => !Object.hasOwn(cb, k) || cb[k] === ca[k])) return true;
    }
    return false;
  }
}

/**
 * A key body is not a URL path; it is matched the same way, segment by
 * segment, but without percent-decoding (the body is already decoded text).
 */
function matchBody(t: PathTemplate, body: string): Captures | null {
  // The body is well-formed (`continues` saw to it): encodeURIComponent
  // throws on a lone surrogate, and parseDescriptor would throw rather than
  // refuse.
  return matchPath(t, body.split('/').map((s) => encodeURIComponent(s)).join('/'));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `v` with every lone surrogate, in values and names alike, read as U+FFFD
 * (N21). That is what Go's JSON decoder does to the whole file, and what a
 * key becomes once it crosses the hub: compared raw, a template and an
 * example differing only there passed on one port and not the other, and a
 * key minted from one never came back equal to the member's own.
 */
function wellFormed(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(LONE_SURROGATE, '\uFFFD');
  if (Array.isArray(v)) return v.map(wellFormed);
  if (typeof v === 'object' && v !== null) {
    // fromEntries defines a `__proto__` name as data, as JSON.parse does;
    // assigning it would set the prototype and hide an unknown field.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [wellFormed(k), wellFormed(x)]));
  }
  return v;
}

function wrap<T>(where: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
}

/** The generic rule's body: the path, trailing slashes dropped. */
export function genericPath(u: URL): string | null {
  const path = u.pathname.replace(/\/+$/, '');
  return path === '' || path === '/' ? null : path;
}

/**
 * A watch template must produce an https page, with no port, credentials or
 * fragment, on one of the descriptor's own hosts -- and a placeholder may sit
 * only in the path or in a query value, never where it could pick the host.
 */
function checkWatchTemplate(src: string, d: Descriptor, where: string): void {
  const m = /^https:\/\/([^/?#{}]+)(\/[^#]*)?$/.exec(src);
  if (!m) throw new Error(`${where}.watch: must be https://<host>/... with no placeholder in the host`);
  const host = m[1]!;
  if (!validHostPattern(host) || host.startsWith('*.')) throw new Error(`${where}.watch: bad host "${host}"`);
  if (!coveredBy(host, d.hosts)) throw new Error(`${where}.watch: host "${host}" is not in "hosts"`);
  // Substituted values are encoded into plain characters; the literal text
  // must be plain too, or the ports read the produced URL differently.
  if (!plainUrl(src.replace(/\{[^{}]*\}/g, 'x'))) {
    throw new Error(`${where}.watch: not a plain URL (printable ASCII, nothing a URL parser rewrites)`);
  }
  const rest = m[2] ?? '/';
  const q = rest.indexOf('?');
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      if (name.includes('{') || name.includes('}')) throw new Error(`${where}.watch: a placeholder may not name a query parameter`);
    }
  }
}

export type CompileResult =
  | { ok: true; provider: Provider }
  | { ok: false; errors: string[] };

/**
 * Validate a parsed descriptor, compile it, and run its examples. Everything
 * that fails is reported, not just the first thing.
 */
export function compileDescriptor(raw: unknown): CompileResult {
  const v = wellFormed(raw);
  const p = new Problems();
  checkStructure(v, p);
  if (p.list.length) return { ok: false, errors: p.list };
  let provider: Provider;
  try {
    provider = new Provider(v as Descriptor);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const failed = runExamples(provider);
  if (failed.length) return { ok: false, errors: failed };
  return { ok: true, provider };
}

/** `compileDescriptor` on JSON text, with the size limit applied to the bytes. */
export function parseDescriptor(text: string): CompileResult {
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    return { ok: false, errors: [`descriptor: larger than ${MAX_BYTES} bytes`] };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`descriptor: not JSON (${(e as Error).message})`] };
  }
  return compileDescriptor(v);
}

/**
 * A URL written the way both ports read alike: `http(s)://host[:port]`, a
 * path, query and fragment of printable ASCII that neither parser rewrites,
 * and a host that is a name (no `xn--` label) or a dotted-quad address. Outside it net/url and
 * URL disagree -- URL strips tabs and newlines, reads a backslash as `/`, takes
 * `https:host`, re-reads a numeric host as an address and refuses a port over
 * 65535; net/url re-escapes `|` and `^` -- so the server would list a
 * descriptor every client refuses (N11). Examples and watch templates are
 * the author's own text; only they are held to it. The Go port has the same
 * pattern and the same host rule; providers/testdata/templates.json "urls"
 * holds both to it.
 */
export function plainUrl(s: string): boolean {
  const m = PLAIN_URL.exec(s);
  if (!m) return false;
  if (m[2] !== undefined && Number(m[2]) > 65535) return false;
  return plainHost(m[1]!);
}

const PLAIN_URL = new RegExp(
  '^https?://([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?' +
  "(?:/(?:[A-Za-z0-9._~!$&()*+,;=:@/-]|%[0-9A-Fa-f]{2})*)?" +
  "(?:\\?(?:[A-Za-z0-9._~!$&()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*)?" +
  "(?:#(?:[A-Za-z0-9._~!$&()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*)?$");

function plainHost(host: string): boolean {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  const labels = name.split('.');
  if (labels.some((l) => l === '' || aceLabel(l))) return false;
  // URL reads a host whose last label is a number as an IPv4 address and
  // rewrites it (`1.2.3` is 1.2.0.3); net/url keeps the text. Only the form
  // both leave alone is taken.
  const last = labels[labels.length - 1]!;
  if (!/^[0-9]+$/.test(last) && !/^0x[0-9a-f]*$/i.test(last)) return true;
  return name === host && labels.length === 4 &&
    labels.every((l) => /^(0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255);
}

/**
 * Evaluate one URL against one descriptor alone: what `examples` assert.
 * `claimed` false means the descriptor does not speak for this host at all.
 */
export function evaluate(provider: Provider, href: string): { claimed: boolean; key: string | null; watch: string | null } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { claimed: false, key: null, watch: null };
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || provider.claims(u.hostname) === 0) {
    return { claimed: false, key: null, watch: null };
  }
  const key = provider.keyFor(u);
  const raw = key ? provider.rawWatchFor(u) : null;
  return { claimed: true, key, watch: raw && roundTrips(provider, raw, key) ? raw : null };
}

/** A produced watch URL must name the media it was produced for. */
export function roundTrips(provider: Provider, watch: string, key: string | null): boolean {
  try {
    const w = new URL(watch);
    return w.protocol === 'https:' && provider.claims(w.hostname) > 0 && provider.keyFor(w) === key;
  } catch {
    return false;
  }
}

function runExamples(provider: Provider): string[] {
  const out: string[] = [];
  const d = provider.d;
  if (!d.examples.some((e) => 'url' in e && e.key !== null)) {
    out.push('examples: at least one example must name media');
  }
  d.examples.forEach((e, i) => {
    const w = `examples[${i}]`;
    if ('url' in e) {
      if (!plainUrl(e.url)) {
        out.push(`${w}: ${JSON.stringify(e.url)} is not a plain URL (printable ASCII, nothing a URL parser rewrites)`);
        return;
      }
      const got = evaluate(provider, e.url);
      if (got.key !== e.key) out.push(`${w}: ${e.url} gives key ${JSON.stringify(got.key)}, expected ${JSON.stringify(e.key)}`);
      else if (e.key !== null && got.watch === null) out.push(`${w}: ${e.url} has no watch URL that names the same media`);
      else if (e.watch !== undefined && got.watch !== e.watch) {
        out.push(`${w}: ${e.url} gives watch ${JSON.stringify(got.watch)}, expected ${JSON.stringify(e.watch)}`);
      }
    } else if (provider.continues(e.from, e.to) !== e.continues) {
      out.push(`${w}: ${e.from} -> ${e.to} should ${e.continues ? '' : 'not '}continue`);
    }
  });
  return out;
}

/** For callers that hold a hostname from `location`, not a URL. */
export { normHost };
