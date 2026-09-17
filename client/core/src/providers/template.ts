/**
 * The segment-template language provider descriptors use instead of regular
 * expressions (docs/design/providers.md).
 *
 * Why not a regex: a descriptor can come from a server or be pasted by a user,
 * and a `mediaUrl` that every client normalises is chosen by whichever room
 * member sent it. Browser JS has no linear-time regex engine and no match
 * timeout, so one crafted pattern plus one crafted URL would hang every tab in
 * the room. This grammar has no way to backtrack: a path template is a list of
 * segments compared left to right, with at most one `**`, always last.
 *
 * The Go port (server/internal/provider/template.go) must accept and reject
 * exactly what this accepts and rejects; providers/testdata/templates.json is
 * run by both suites for that reason. Change one, change the other and the
 * vectors.
 */

/** Hard limits. They are part of the grammar: both ports enforce the same ones. */
export const LIMITS = {
  segments: 16,
  queryParams: 8,
  idLen: 128,
  anyLen: 256,
  intLen: 20,
  literalLen: 128,
  nameLen: 32,
  keyTemplateLen: 256,
  watchTemplateLen: 512,
} as const;

export type SegmentKind = 'id' | 'int' | 'any';

export type Segment =
  | { t: 'lit'; value: string }
  | { t: 'cap'; name: string; kind: SegmentKind }
  | { t: 'alt'; name: string; alts: readonly string[] }
  | { t: 'rest' };

export interface PathTemplate {
  readonly source: string;
  readonly segments: readonly Segment[];
  /** Capture names, in order. */
  readonly names: readonly string[];
}

export interface QueryTemplate {
  readonly params: ReadonlyArray<{ name: string; seg: Segment }>;
  readonly names: readonly string[];
}

export type Captures = Record<string, string>;

const NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const WORD = /^[A-Za-z0-9._~-]+$/;
const INT = /^[0-9]+$/;
const PARAM = /^[A-Za-z0-9._~-]{1,64}$/;

/** Code points, not UTF-16 units: Go counts runes, and the limit must agree. */
const cpLen = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

function parseSegment(raw: string, where: string): Segment {
  if (raw === '**') return { t: 'rest' };
  if (raw.startsWith('{')) {
    if (!raw.endsWith('}')) throw new Error(`${where}: unclosed placeholder "${raw}"`);
    const body = raw.slice(1, -1);
    const colon = body.indexOf(':');
    const name = colon < 0 ? body : body.slice(0, colon);
    const type = colon < 0 ? 'id' : body.slice(colon + 1);
    if (!NAME.test(name)) throw new Error(`${where}: bad placeholder name "${name}"`);
    if (type === 'id' || type === 'int' || type === 'any') return { t: 'cap', name, kind: type };
    const alts = type.split('|');
    for (const a of alts) {
      if (!a || !WORD.test(a) || a.length > LIMITS.literalLen) {
        throw new Error(`${where}: bad placeholder type "${type}"`);
      }
    }
    return { t: 'alt', name, alts };
  }
  if (!WORD.test(raw) || raw.length > LIMITS.literalLen || raw === '.' || raw === '..') {
    throw new Error(`${where}: bad literal segment "${raw}"`);
  }
  return { t: 'lit', value: raw };
}

/**
 * `/player/{series:int}/{episode:int}`, `/{id}/**`, `/`.
 * @throws Error naming what is wrong.
 */
export function parsePathTemplate(src: string): PathTemplate {
  if (typeof src !== 'string' || !src.startsWith('/')) throw new Error(`path "${src}": must start with "/"`);
  const parts = src === '/' ? [] : src.slice(1).split('/');
  if (parts.length > LIMITS.segments) throw new Error(`path "${src}": more than ${LIMITS.segments} segments`);
  const segments: Segment[] = [];
  const names: string[] = [];
  parts.forEach((p, i) => {
    if (p === '') throw new Error(`path "${src}": empty segment`);
    const seg = parseSegment(p, `path "${src}"`);
    if (seg.t === 'rest' && i !== parts.length - 1) throw new Error(`path "${src}": "**" must be last`);
    if (seg.t === 'cap' || seg.t === 'alt') {
      if (names.includes(seg.name)) throw new Error(`path "${src}": "${seg.name}" captured twice`);
      names.push(seg.name);
    }
    segments.push(seg);
  });
  return { source: src, segments, names };
}

/** `{"v": "{id:any}"}` -- a value is a whole placeholder or a literal word. */
export function parseQueryTemplate(q: unknown, taken: readonly string[] = []): QueryTemplate {
  if (typeof q !== 'object' || q === null || Array.isArray(q)) throw new Error('query: must be an object');
  const entries = Object.entries(q as Record<string, unknown>);
  if (entries.length === 0) throw new Error('query: empty');
  if (entries.length > LIMITS.queryParams) throw new Error(`query: more than ${LIMITS.queryParams} parameters`);
  const params: Array<{ name: string; seg: Segment }> = [];
  const names: string[] = [];
  for (const [k, v] of entries) {
    if (!PARAM.test(k)) throw new Error(`query: bad parameter name "${k}"`);
    if (typeof v !== 'string' || v === '') throw new Error(`query "${k}": value must be a non-empty string`);
    const seg = parseSegment(v, `query "${k}"`);
    if (seg.t === 'rest') throw new Error(`query "${k}": "**" is a path form`);
    if (seg.t === 'cap' || seg.t === 'alt') {
      if (names.includes(seg.name) || taken.includes(seg.name)) {
        throw new Error(`query "${k}": "${seg.name}" captured twice`);
      }
      names.push(seg.name);
    }
    params.push({ name: k, seg });
  }
  return { params, names };
}

function segmentMatches(seg: Segment, value: string, out: Captures): boolean {
  switch (seg.t) {
    case 'lit':
      return value === seg.value;
    case 'alt':
      if (!seg.alts.includes(value)) return false;
      out[seg.name] = value;
      return true;
    case 'cap': {
      let ok: boolean;
      if (seg.kind === 'int') ok = value.length <= LIMITS.intLen && INT.test(value);
      else if (seg.kind === 'id') ok = value.length <= LIMITS.idLen && WORD.test(value);
      else ok = value !== '' && cpLen(value) <= LIMITS.anyLen;
      if (ok) out[seg.name] = value;
      return ok;
    }
    case 'rest':
      return false;
  }
}

/**
 * Match a URL's pathname (as `URL.pathname` gives it: percent-encoded).
 *
 * Empty segments are dropped, so `/a//b/` is `/a/b` -- YouTube's rule has
 * always read the path that way, and a key that differs by a doubled slash
 * would fork a room. Each segment is percent-decoded once; one that does not
 * decode to valid UTF-8 matches nothing.
 */
export function matchPath(t: PathTemplate, pathname: string): Captures | null {
  const parts = pathname.split('/').filter((p) => p !== '');
  const out: Captures = {};
  let i = 0;
  for (const seg of t.segments) {
    if (seg.t === 'rest') return out;
    const raw = parts[i++];
    if (raw === undefined) return null;
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!segmentMatches(seg, value, out)) return null;
  }
  return i === parts.length ? out : null;
}

/**
 * The first value of each parameter, as `URLSearchParams.get` gives it
 * (form-decoded: `+` is a space, a bad escape is kept as text). The Go port
 * reproduces that by hand.
 */
export function firstQueryValues(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(search)) {
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

export function matchQuery(t: QueryTemplate, search: string): Captures | null {
  const got = firstQueryValues(search);
  const out: Captures = {};
  for (const p of t.params) {
    const v = got.get(p.name);
    if (v === undefined || v === '') return null;
    if (!segmentMatches(p.seg, v, out)) return null;
  }
  return out;
}

/** A key or watch template: literal text with `{name}` placeholders. */
export interface TextTemplate {
  readonly source: string;
  readonly parts: ReadonlyArray<{ lit: string } | { name: string }>;
  readonly names: readonly string[];
}

export function parseTextTemplate(src: string, allowed: readonly string[], maxLen: number): TextTemplate {
  if (typeof src !== 'string' || src === '') throw new Error('template: must be a non-empty string');
  if (cpLen(src) > maxLen) throw new Error(`template "${src}": longer than ${maxLen}`);
  const parts: Array<{ lit: string } | { name: string }> = [];
  const names: string[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    const close = src.indexOf('}', i);
    if (open < 0) {
      if (close >= 0) throw new Error(`template "${src}": stray "}"`);
      parts.push({ lit: src.slice(i) });
      break;
    }
    if (close >= 0 && close < open) throw new Error(`template "${src}": stray "}"`);
    if (open > i) parts.push({ lit: src.slice(i, open) });
    const end = src.indexOf('}', open);
    if (end < 0) throw new Error(`template "${src}": unclosed "{"`);
    const name = src.slice(open + 1, end);
    if (!NAME.test(name)) throw new Error(`template "${src}": bad placeholder "{${name}}"`);
    if (!allowed.includes(name)) throw new Error(`template "${src}": "{${name}}" is not captured by this rule`);
    parts.push({ name });
    if (!names.includes(name)) names.push(name);
    i = end + 1;
  }
  return { source: src, parts, names };
}

/**
 * What `encodeURIComponent` does, spelled out so the Go port can match it:
 * everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8 percent-escapes.
 */
export function encodeComponent(s: string): string {
  return encodeURIComponent(s);
}

export function substitute(t: TextTemplate, caps: Captures, encode: boolean): string {
  let out = '';
  for (const p of t.parts) {
    if ('lit' in p) out += p.lit;
    else {
      const v = caps[p.name] ?? '';
      out += encode ? encodeComponent(v) : v;
    }
  }
  return out;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * An IDNA `xn--` label. Node's URL and Go's net/url take any such label as
 * text; a browser runs UTS46 and refuses one that is not valid punycode of a
 * valid name (`xn--a`, `xn--`), so a descriptor the tests and the server
 * accept would fail in every real client. Telling the valid ones apart needs
 * the IDNA tables, so a descriptor may not name an IDN host at all. The Go
 * port's aceLabel is the same rule.
 */
export function aceLabel(l: string): boolean {
  return l.toLowerCase().startsWith('xn--');
}

/**
 * A descriptor host: lowercase ASCII, exact or with a leading `*.`, at least
 * two labels. ASCII only is what keeps a homograph from ever equalling one: a
 * look-alike reaches us as `xn--...`, and no `xn--` label is taken at all
 * (see aceLabel).
 */
export function validHostPattern(p: string): boolean {
  if (typeof p !== 'string') return false;
  const wild = p.startsWith('*.');
  const base = wild ? p.slice(2) : p;
  if (base.length === 0 || base.length > 253) return false;
  const labels = base.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL.test(l) && !aceLabel(l))) return false;
  // `*.1.2.3` is a wildcard over an address, which is no host at all.
  if (wild && /^[0-9]+$/.test(labels[labels.length - 1]!)) return false;
  return true;
}

/** A parsed hostname as descriptors compare it: lowercase, one trailing dot dropped. */
export function normHost(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/**
 * How specifically `pattern` claims `hostname`: 0 for not at all, otherwise
 * higher is more specific. An exact host beats any wildcard over the same
 * labels; a longer wildcard beats a shorter one.
 */
export function hostScore(pattern: string, hostname: string): number {
  const h = normHost(hostname);
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return h.endsWith(`.${base}`) ? base.split('.').length * 2 : 0;
  }
  return h === pattern ? pattern.split('.').length * 2 + 1 : 0;
}

/** The best score any of `patterns` gives `hostname`. */
export function bestHostScore(patterns: readonly string[], hostname: string): number {
  let best = 0;
  for (const p of patterns) best = Math.max(best, hostScore(p, hostname));
  return best;
}
