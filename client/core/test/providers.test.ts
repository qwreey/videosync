/**
 * Provider descriptors (D7): the template grammar, the validator, the
 * built-ins, and how a registry decides who speaks for a host.
 *
 * The grammar and validator vectors live in providers/testdata/ and the Go
 * suite runs the same files; a case added here without the other port
 * agreeing fails there.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { followableUrl, normalizeMediaKey, providerId, watchUrl } from '../src/adapter/mediakey.ts';
import {
  buildRegistry, diffDescriptors, mayAutoAdopt, openOffers, parseIndex, pendingUpdates, readState,
  serverOrigin, sha256Hex, widens, writeState,
} from '../src/providers/adoption.ts';
import type { ProviderState } from '../src/providers/adoption.ts';
import { compileDescriptor, parseDescriptor } from '../src/providers/descriptor.ts';
import type { Descriptor } from '../src/providers/descriptor.ts';
import { BUILTIN_SOURCES } from '../src/providers/builtin.gen.ts';
import { builtinRegistry, ProviderRegistry } from '../src/providers/registry.ts';
import {
  encodeComponent, hostScore, matchPath, matchQuery, parsePathTemplate, parseQueryTemplate, parseTextTemplate,
  substitute, validHostPattern,
} from '../src/providers/template.ts';
import { legacyNormalizeMediaKey, legacyWatchUrl } from './legacy-mediakey.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const readJson = (p: string): any => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('the template grammar (shared vectors)', () => {
  const v = readJson('providers/testdata/templates.json');

  it('matches paths', () => {
    for (const g of v.path) {
      const t = parsePathTemplate(g.template);
      for (const c of g.cases) {
        assert.deepEqual(matchPath(t, c.path), c.captures, `${g.template} vs ${c.path}`);
      }
    }
  });

  it('rejects malformed path templates', () => {
    for (const src of v.invalidPath) {
      assert.throws(() => parsePathTemplate(src), undefined, JSON.stringify(src));
    }
  });

  it('matches queries', () => {
    for (const g of v.query) {
      const t = parseQueryTemplate(g.template);
      for (const c of g.cases) {
        assert.deepEqual(matchQuery(t, c.search), c.captures, `${JSON.stringify(g.template)} vs ${c.search}`);
      }
    }
  });

  it('rejects malformed query templates', () => {
    for (const q of v.invalidQuery) {
      assert.throws(() => parseQueryTemplate(q), undefined, JSON.stringify(q));
    }
  });

  it('substitutes, encoding only where asked', () => {
    for (const c of v.substitute) {
      const t = parseTextTemplate(c.template, Object.keys(c.captures), 512);
      assert.equal(substitute(t, c.captures, c.encode), c.out, c.template);
    }
    // The encoder is encodeURIComponent, which the Go port reimplements.
    assert.equal(encodeComponent("!'()*-._~ /"), "!'()*-._~%20%2F");
  });

  it('scores hosts on the parsed hostname, dot boundary included', () => {
    for (const c of v.hosts) {
      assert.equal(hostScore(c.pattern, c.host), c.score, `${c.pattern} vs ${c.host}`);
    }
  });

  it('accepts only plain lowercase ASCII host patterns', () => {
    for (const h of v.invalidHosts) assert.equal(validHostPattern(h), false, JSON.stringify(h));
    for (const h of v.validHosts) assert.equal(validHostPattern(h), true, JSON.stringify(h));
  });

  it('takes linear time on a hostile path', () => {
    // The reason there is no regex: this is the shape that hangs a
    // backtracking engine, and a room member chooses the URL.
    const t = parsePathTemplate('/{a:any}/{b:any}/{c:any}/{d:any}/**');
    const hostile = `/${'a/'.repeat(100_000)}!`;
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) matchPath(t, hostile);
    assert.ok(performance.now() - t0 < 2000, 'matching a 200 kB path took seconds');
  });
});

describe('descriptor validation (shared vectors)', () => {
  const v = readJson('providers/testdata/descriptors.json');
  const build = (c: { set?: Record<string, unknown>; replace?: unknown }): unknown => {
    if ('replace' in c) return c.replace;
    const d: Record<string, unknown> = structuredClone(v.base);
    for (const [k, val] of Object.entries(c.set ?? {})) {
      if (val === null) delete d[k];
      else d[k] = val;
    }
    return d;
  };

  it('accepts and rejects exactly what the Go port does', () => {
    for (const c of v.cases) {
      const r = compileDescriptor(build(c));
      assert.equal(r.ok, c.valid, `${c.name}: ${r.ok ? 'accepted' : r.errors.join('; ')}`);
    }
  });

  it('refuses text over 16 KiB before parsing it', () => {
    const d = build({ set: { notes: 'x'.repeat(2000) } });
    const text = JSON.stringify(d, null, 2) + ' '.repeat(16 * 1024);
    const r = parseDescriptor(text);
    assert.equal(r.ok, false);
    // Control: the same descriptor, small, is fine.
    assert.equal(parseDescriptor(JSON.stringify(d)).ok, true);
  });

  it('refuses a descriptor that is not JSON', () => {
    assert.equal(parseDescriptor('{"schema": 1,').ok, false);
  });
});

describe('the built-in descriptors', () => {
  it('are all valid, examples included', () => {
    assert.ok(BUILTIN_SOURCES.length >= 2);
    for (const b of BUILTIN_SOURCES) {
      const r = parseDescriptor(b.source);
      assert.ok(r.ok, `${b.file}: ${r.ok ? '' : r.errors.join('; ')}`);
    }
    assert.equal(builtinRegistry().entries.length, BUILTIN_SOURCES.length);
  });

  it('are compiled from the current providers/*.json, byte for byte', async () => {
    // builtin.gen.ts is committed; a JSON edit without regenerating would
    // ship the old descriptor while CI read the new one.
    const { loadBuiltins, renderGenerated, GENERATED } = await import('../scripts/providers.mjs');
    const fresh = renderGenerated(loadBuiltins());
    assert.equal(readFileSync(GENERATED, 'utf8'), fresh, 'run `node scripts/providers.mjs` in client/core');
    for (const b of BUILTIN_SOURCES) {
      const bytes = readFileSync(join(ROOT, 'providers', b.file));
      assert.equal(b.sha256, createHash('sha256').update(bytes).digest('hex'), b.file);
      assert.equal(await sha256Hex(b.source), b.sha256, 'the client hashes text the same way');
    }
  });

  it('generate the page match patterns the shims ship with', async () => {
    const { loadBuiltins, matchPatterns } = await import('../scripts/providers.mjs');
    assert.deepEqual(new Set(matchPatterns(loadBuiltins())), new Set([
      'https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://laftel.net/*',
    ]));
  });

  it('reproduce the keys the code rules produced, except where F20 is closed', () => {
    // A member on the previous release must compute the same key for the
    // same page, or the two sit in different rooms. The only intended
    // difference: a Laftel page that is not a player names no media now.
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
      'https://m.youtube.com/watch?v=abc&list=PL1', 'https://music.youtube.com/watch?v=abc',
      'https://youtu.be/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ/extra?t=1', 'https://www.youtu.be/x',
      'https://www.youtube.com/embed/abc', 'https://www.youtube.com/embed/abc/more',
      'https://www.youtube.com/shorts/abc', 'https://www.youtube.com/live/abc', 'https://www.youtube.com/v/abc',
      'https://www.youtube.com/embed/', 'https://www.youtube.com/watch?v=abc&v=def',
      'https://www.youtube.com/embed/abc?v=zzz', 'https://www.youtube-nocookie.com/embed/abc',
      'https://youtube-nocookie.com/watch?v=abc', 'http://www.youtube.com/watch?v=abc',
      'https://www.youtube.com/', 'https://www.youtube.com/results?search_query=x', 'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?list=PL1', 'https://www.youtube.com/@channel', 'https://youtu.be/',
      'https://www.youtube.com/watch?v=a-b_c', 'https://www.youtube.com/watch?v=%E2%82%AC',
      'https://notyoutube.com/watch?v=x', 'https://youtube.com.evil.example/watch?v=x',
      'https://laftel.net/player/12345/67890?utm_source=x', 'https://laftel.net/player/12345/67890/',
      'https://www.laftel.net/player/1/2', 'https://laftel.net', 'https://laftel.net/',
      'https://laftel.net.evil.example/player/1/2', 'https://evillaftel.net/player/1/2',
      'https://WWW.Example.COM/Watch/AbC', 'https://example.org/videos/42?x=1', 'https://example.org/',
      'https://video.example:8443/v/1/', 'about:blank', 'javascript:alert(1)', 'not a url', '',
    ];
    for (const u of urls) {
      assert.equal(normalizeMediaKey(u), legacyNormalizeMediaKey(u), u);
      assert.equal(watchUrl(u), legacyWatchUrl(u), `watch ${u}`);
    }
    for (const u of ['https://laftel.net/logout', 'https://laftel.net/item/45462', 'https://laftel.net/player/1',
      'https://laftel.net/player/1/2/3', 'https://laftel.net/search?q=x']) {
      assert.notEqual(legacyNormalizeMediaKey(u), null, `control: ${u} used to be keyed`);
      assert.equal(normalizeMediaKey(u), null, u);
    }
  });

  it('close F20 for Laftel: a room cannot send members to a non-player page', () => {
    const here = 'https://laftel.net/player/1/2';
    assert.equal(followableUrl('https://laftel.net/logout', 'laftel:/logout', here), null);
    // Control: the player page still is followed.
    assert.equal(followableUrl('https://laftel.net/player/1/3', 'laftel:/player/1/3', here),
      'https://laftel.net/player/1/3');
  });

  it('say which episode continues which (for D8)', () => {
    const laftel = builtinRegistry().byId('laftel')!.provider;
    assert.equal(laftel.continues('laftel:/player/1/2', 'laftel:/player/1/3'), true);
    assert.equal(laftel.continues('laftel:/player/1/2', 'laftel:/player/9/3'), false);
    const yt = builtinRegistry().byId('yt')!.provider;
    assert.equal(yt.continues('yt:a', 'yt:b'), false, 'YouTube says nothing about continuation');
  });
});

// ---------------------------------------------------------------------------

const BASE: Descriptor = readJson('providers/testdata/descriptors.json').base;

function variant(over: Partial<Descriptor>): Descriptor {
  return { ...structuredClone(BASE), ...over };
}

async function stored(d: Descriptor) {
  const source = JSON.stringify(d);
  return { source, sha256: await sha256Hex(source) };
}

const EMPTY: ProviderState = { user: [], adopted: [], servers: {} };

describe('the effective registry', () => {
  it('lets a user descriptor name a host, but not make it followable without a grant', async () => {
    const reg = buildRegistry({ ...EMPTY, user: [await stored(BASE)] }, () => false);
    assert.equal(normalizeMediaKey('https://video.example/watch/abc', reg), 'example:/watch/abc');
    assert.equal(normalizeMediaKey('https://video.example/logout', reg), null, 'pathFallback false');
    assert.equal(providerId('video.example', reg), 'example');
    // Not granted: only from the same site, like any unknown host.
    assert.equal(followableUrl('https://video.example/watch/abc', 'example:/watch/abc', 'https://laftel.net/', reg), null);
    assert.equal(followableUrl('https://video.example/watch/abc', 'example:/watch/abc', 'https://video.example/x', reg),
      'https://video.example/watch/abc');
    // Granted: followable from anywhere.
    const granted = buildRegistry({ ...EMPTY, user: [await stored(BASE)] }, (h) => h === 'video.example');
    assert.equal(followableUrl('https://video.example/watch/abc', 'example:/watch/abc', 'https://laftel.net/', granted),
      'https://video.example/watch/abc');
    // Without the descriptor, the generic rule, as before.
    assert.equal(normalizeMediaKey('https://video.example/logout'), 'video.example:/logout');
  });

  it('never follows a granted subdomain to an ungranted canonical host', async () => {
    const d = variant({});
    const reg = buildRegistry({ ...EMPTY, user: [await stored(d)] }, (h) => h === 'www.video.example');
    assert.equal(followableUrl('https://www.video.example/watch/abc', 'example:/watch/abc', 'https://laftel.net/', reg), null);
  });

  it('applies neither of two descriptors that tie for a host, and says so', async () => {
    const a = variant({ id: 'aaa', keyPrefix: 'aaa' , examples: [{ url: 'https://video.example/watch/x', key: 'aaa:/watch/x' }] });
    const b = variant({ id: 'bbb', keyPrefix: 'bbb', examples: [{ url: 'https://video.example/watch/x', key: 'bbb:/watch/x' }] });
    const reg = buildRegistry({ ...EMPTY, user: [await stored(a), await stored(b)] }, () => true);
    const l = reg.lookup('video.example');
    assert.equal(l.entry, null);
    assert.deepEqual(l.conflict.map((e) => e.provider.id).sort(), ['aaa', 'bbb']);
    assert.equal(normalizeMediaKey('https://video.example/logout', reg), 'video.example:/logout', 'generic rule');
    // The more specific host wins over a tie-breaker nobody chose.
    const c = variant({
      id: 'ccc', keyPrefix: 'ccc', hosts: ['www.video.example'], canonicalHost: 'www.video.example',
      identity: [{ path: '/watch/{id}', key: '/watch/{id}', watch: 'https://www.video.example/watch/{id}' }],
      examples: [{ url: 'https://www.video.example/watch/x', key: 'ccc:/watch/x' }],
    });
    const reg2 = buildRegistry({ ...EMPTY, user: [await stored(a), await stored(c)] }, () => true);
    assert.equal(reg2.lookup('www.video.example').entry?.provider.id, 'ccc');
    assert.equal(reg2.lookup('video.example').entry?.provider.id, 'aaa');
  });

  it('puts a user descriptor over the built-in with the same id', async () => {
    const yt = JSON.parse(BUILTIN_SOURCES.find((b) => b.file === 'youtube.json')!.source) as Descriptor;
    const narrowed = { ...yt, identity: yt.identity.slice(1) };
    narrowed.examples = [{ url: 'https://www.youtube.com/watch?v=abc', key: 'yt:abc' }];
    const reg = buildRegistry({ ...EMPTY, user: [await stored(narrowed)] }, () => false);
    assert.equal(reg.lookup('youtu.be').entry?.tier, 'user');
    assert.equal(normalizeMediaKey('https://youtu.be/abc', reg), null, 'the user dropped the youtu.be rule');
    assert.equal(normalizeMediaKey('https://youtu.be/abc'), 'yt:abc', 'control: built-in');
  });

  it('replaces a built-in with a server copy only after the user confirmed it', async () => {
    const lf = JSON.parse(BUILTIN_SOURCES.find((b) => b.file === 'laftel.json')!.source) as Descriptor;
    const changed = { ...lf, version: '1.1.0', video: { exclude: ['.preview'] } };
    const s = await stored(changed);
    const adopted = (replaceBuiltin: boolean) => ({
      ...EMPTY, adopted: [{ ...s, id: 'laftel', server: 'https://sync.example', replaceBuiltin }],
    });
    const no = buildRegistry(adopted(false), () => true);
    assert.equal(no.byId('laftel')?.tier, 'built-in');
    assert.ok(no.notes.some((n) => n.includes('confirmation')), no.notes.join());
    const yes = buildRegistry(adopted(true), () => true);
    assert.equal(yes.byId('laftel')?.tier, 'server');
    assert.equal(yes.byId('laftel')?.sha256, s.sha256);
  });

  it('skips a stored descriptor that no longer validates, with a note', () => {
    const reg = buildRegistry({ ...EMPTY, user: [{ source: '{"schema":9}', sha256: 'x' }] }, () => true);
    assert.equal(reg.entries.length, BUILTIN_SOURCES.length);
    assert.equal(reg.notes.length, 1);
  });

  it('round-trips through a store and survives garbage in it', async () => {
    const data = new Map<string, string>();
    const s: ProviderState = {
      user: [await stored(BASE)],
      adopted: [{ ...(await stored(BASE)), id: 'example', server: 'https://s.example', replaceBuiltin: false }],
      servers: { 'https://s.example': { autoAdopt: true } },
    };
    writeState((k, v) => data.set(k, v), s);
    assert.deepEqual(readState((k) => data.get(k) ?? ''), s);
    data.set('providers.user', '{not json');
    data.set('providers.adopted', '[{"source":1}]');
    assert.deepEqual(readState((k) => data.get(k) ?? ''), { ...s, user: [], adopted: [] });
  });
});

describe('what a server offers', () => {
  const idx = (sha: string, id = 'example') =>
    JSON.stringify({ schema: 1, providers: [{ id, name: 'Example', version: '1.0.0', sha256: sha, hosts: ['video.example'] }] });
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('parses the index and drops malformed rows', () => {
    assert.equal(parseIndex(idx(A)).length, 1);
    assert.equal(parseIndex(idx('nothex')).length, 0);
    assert.equal(parseIndex(idx(A, 'Bad Id')).length, 0);
    assert.deepEqual(parseIndex('<html>'), []);
    assert.deepEqual(parseIndex('{"providers":{}}'), []);
  });

  it('notices a pinned descriptor whose server copy changed, and only from that server', () => {
    const s: ProviderState = {
      ...EMPTY,
      adopted: [{ source: '', sha256: A, id: 'example', server: 'https://s.example', replaceBuiltin: false }],
    };
    assert.equal(pendingUpdates(s, 'https://s.example/', parseIndex(idx(A))).length, 0, 'unchanged');
    assert.equal(pendingUpdates(s, 'https://s.example/', parseIndex(idx(B))).length, 1, 'changed');
    assert.equal(pendingUpdates(s, 'https://other.example', parseIndex(idx(B))).length, 0, 'another server');
    assert.equal(serverOrigin('https://s.example/some/path'), 'https://s.example');
  });

  it('offers what was neither adopted nor declined, and offers a declined one again once it changes', () => {
    const s: ProviderState = { ...EMPTY, servers: { 'https://s.example': { declined: { example: A } } } };
    assert.equal(openOffers(s, 'https://s.example', parseIndex(idx(A))).length, 0);
    assert.equal(openOffers(s, 'https://s.example', parseIndex(idx(B))).length, 1);
    assert.equal(openOffers(EMPTY, 'https://s.example', parseIndex(idx(A))).length, 1);
  });
});

describe('what a change widens', () => {
  it('flags every field that lets a descriptor claim or reach more', () => {
    const cases: Array<[string, Partial<Descriptor>, boolean]> = [
      ['version only', { version: '1.0.1' }, false],
      ['a narrower host list', { hosts: ['video.example'] }, false],
      ['a new host', { hosts: [...BASE.hosts, 'other.example'] }, true],
      ['a subdomain already covered', { hosts: [...BASE.hosts, 'www.video.example'] }, false],
      ['a new canonical host', { canonicalHost: 'www.video.example' }, true],
      ['pathFallback turned on', { pathFallback: true }, true],
      ['a new identity rule', { identity: [...BASE.identity, { path: '/v/{id}', key: '/v/{id}', watch: 'https://video.example/v/{id}' }] }, true],
      ['identity rules removed', { identity: [] }, false],
      ['a new key prefix', { keyPrefix: 'other' }, true],
      ['a capability restricted', { capabilities: { directSeek: false } }, false],
      ['selectors changed', { video: { exclude: ['.x'] } }, false],
      ['page hosts widened', { pageHosts: ['video.example', 'www.video.example'] }, false],
    ];
    for (const [name, over, want] of cases) {
      assert.equal(widens(BASE, variant(over)), want, name);
    }
    const restricted = variant({ capabilities: { directSeek: false } });
    assert.equal(widens(restricted, BASE), true, 'a capability given back');
    const narrowPages = variant({ pageHosts: ['video.example'] });
    assert.equal(widens(narrowPages, variant({ pageHosts: ['video.example', 'www.video.example'] })), true);
    assert.equal(widens(null, BASE), true, 'a descriptor nobody had');
  });

  it('shows the difference field by field', () => {
    const d = diffDescriptors(BASE, variant({ version: '2.0.0', pathFallback: true }));
    assert.deepEqual(d.map((c) => c.field).sort(), ['pathFallback', 'version']);
    assert.equal(d.find((c) => c.field === 'pathFallback')?.before, false);
  });

  it('auto-adopts only with the server opted in, and only what widens nothing', () => {
    const on: ProviderState = { ...EMPTY, servers: { 'https://s.example': { autoAdopt: true } } };
    const narrower = variant({ version: '1.0.1', video: { exclude: ['.ad'] } });
    const wider = variant({ pathFallback: true });
    assert.equal(mayAutoAdopt(on, 'https://s.example', BASE, narrower), true);
    assert.equal(mayAutoAdopt(on, 'https://s.example', BASE, wider), false);
    assert.equal(mayAutoAdopt(EMPTY, 'https://s.example', BASE, narrower), false, 'off by default');
    assert.equal(mayAutoAdopt(on, 'https://other.example', BASE, narrower), false);
  });
});

describe('a registry with nothing in it', () => {
  it('is the generic path rule everywhere', () => {
    const reg = new ProviderRegistry([]);
    assert.equal(normalizeMediaKey('https://www.youtube.com/watch?v=abc', reg), 'youtube.com:/watch');
    assert.equal(watchUrl('https://laftel.net/logout?x=1', reg), 'https://laftel.net/logout');
  });
});
