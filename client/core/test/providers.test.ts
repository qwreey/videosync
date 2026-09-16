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

import { Html5Adapter } from '../src/adapter/html5.ts';
import { continuesMedia, followableUrl, normalizeMediaKey, providerId, watchUrl } from '../src/adapter/mediakey.ts';
import {
  buildRegistry, diffDescriptors, mayAutoAdopt, openOffers, parseIndex, pendingUpdates, readState,
  serverOrigin, sha256Hex, widens, writeState,
} from '../src/providers/adoption.ts';
import type { ProviderState } from '../src/providers/adoption.ts';
import { compileDescriptor, parseDescriptor } from '../src/providers/descriptor.ts';
import {
  adopt, autoUpdate, autoUpdateStored, decline, dynamicPagePatterns, grantedBy, missingMatches, originsFor, removeUser, saveUser,
  setAutoAdopt, unadopt,
} from '../src/providers/manage.ts';
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
  const build = (c: { set?: Record<string, unknown>; replace?: unknown }, ...more: Array<Record<string, unknown>>): unknown => {
    if ('replace' in c) return c.replace;
    const d: Record<string, unknown> = structuredClone(v.base);
    for (const layer of [c.set ?? {}, ...more]) {
      for (const [k, val] of Object.entries(layer)) {
        if (val === null) delete d[k];
        else d[k] = val;
      }
    }
    return d;
  };

  it('accepts and rejects exactly what the Go port does', () => {
    let controls = 0;
    for (const c of v.cases) {
      const r = compileDescriptor(build(c));
      assert.equal(r.ok, c.valid, `${c.name}: ${r.ok ? 'accepted' : r.errors.join('; ')}`);
      if (c.control) {
        // Rejected for the named reason alone: take it out and nothing else is wrong.
        controls++;
        const fixed = compileDescriptor(build(c, c.control));
        assert.ok(fixed.ok, `${c.name}: its control is rejected too: ${fixed.ok ? '' : fixed.errors.join('; ')}`);
      }
    }
    assert.ok(controls >= 10, 'the controls did not load');
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

  it('treats a new id that takes a built-in host or key prefix as replacing the built-in', async () => {
    const W = 'https://www.youtube.com';
    /** What the review built: a new id, exact www host, the built-in's prefix, every path a key. */
    const tube = variant({
      id: 'tube', name: 'Tube', keyPrefix: 'yt', hosts: ['www.youtube.com'], canonicalHost: 'www.youtube.com',
      identity: [{ path: '/{p:any}/**', key: '{p}', watch: `${W}/{p}/x` }],
      examples: [{ url: `${W}/watch/x`, key: 'yt:watch', watch: `${W}/watch/x` }],
    });
    /** Takes only the host, with its own prefix. */
    const hostOnly = variant({
      id: 'tube2', name: 'Tube2', hosts: ['www.youtube.com'], canonicalHost: 'www.youtube.com', pathFallback: true,
      identity: [], examples: [{ url: `${W}/logout`, key: 'tube2:/logout' }],
    });
    /** Takes only the prefix, on a host nobody else describes. */
    const prefixOnly = variant({ id: 'foo', keyPrefix: 'laftel', examples: [{ url: 'https://video.example/watch/a', key: 'laftel:/watch/a' }] });
    /** A same-specificity tie on the built-in's wildcard. */
    const tie = variant({
      id: 'tube3', name: 'Tube3', hosts: ['youtube.com', '*.youtube.com'], canonicalHost: 'youtube.com', pathFallback: true,
      identity: [], examples: [{ url: 'https://youtube.com/watch', key: 'tube3:/watch' }],
    });
    /** The control: a new id on a host no built-in describes. */
    const unrelated = variant({ id: 'other', examples: [{ url: 'https://video.example/watch/a', key: 'other:/watch/a' }] });

    const SERVER = 'https://sync.example';
    const asAdopted = async (d: Descriptor, replaceBuiltin: boolean): Promise<ProviderState> => ({
      ...EMPTY, adopted: [{ ...(await stored(d)), id: d.id, server: SERVER, replaceBuiltin }],
    });
    for (const d of [tube, hostOnly, prefixOnly, tie]) {
      const reg = buildRegistry(await asAdopted(d, false), () => true);
      assert.equal(reg.byId(d.id), null, `${d.id} was applied without the replace confirmation`);
      assert.ok(reg.notes.some((n) => n.includes(d.id) && n.includes('confirmation')), reg.notes.join());
      assert.equal(normalizeMediaKey(`${W}/watch?v=abc`, reg), 'yt:abc', d.id);
      assert.equal(followableUrl(`${W}/logout`, 'yt:logout', 'https://laftel.net/', reg), null, d.id);

      const body = JSON.stringify(d);
      const e = { id: d.id, name: d.name, version: d.version, sha256: await sha256Hex(body), hosts: d.hosts };
      const asked = await adopt(EMPTY, SERVER, e, body, false);
      assert.ok(!asked.ok && asked.needsReplaceConfirmation, `${d.id}: adopted as a brand-new descriptor`);
      const yes = await adopt(EMPTY, SERVER, e, body, true);
      assert.ok(yes.ok && yes.state.adopted[0]!.replaceBuiltin, d.id);
      assert.equal(buildRegistry(yes.state, () => true).byId(d.id)?.tier, 'server', `${d.id}: confirmed and still not applied`);

      const saved = await saveUser(EMPTY, body);
      assert.ok(saved.ok && saved.displaces?.length, `${d.id}: saving it did not say it displaces a built-in`);
    }
    const reg = buildRegistry(await asAdopted(unrelated, false), () => true);
    assert.equal(reg.byId('other')?.tier, 'server', 'control: an unrelated new descriptor needs no confirmation');
    const plain = await adopt(EMPTY, SERVER, { id: 'other', name: 'x', version: '1.0.0', sha256: await sha256Hex(JSON.stringify(unrelated)), hosts: [] },
      JSON.stringify(unrelated), false);
    assert.ok(plain.ok && !plain.state.adopted[0]!.replaceBuiltin);
    const savedPlain = await saveUser(EMPTY, JSON.stringify(unrelated));
    assert.ok(savedPlain.ok && !savedPlain.displaces);
  });

  it('keeps a built-in host on the built-in when two descriptors tie there, never the generic rule', async () => {
    const W = 'https://www.youtube.com';
    const tie = (id: string) => variant({
      id, name: id, hosts: ['youtube.com', '*.youtube.com'], canonicalHost: 'youtube.com', pathFallback: true,
      identity: [], examples: [{ url: 'https://youtube.com/watch', key: `${id}:/watch` }],
    });
    // A user descriptor may displace a built-in; tying with it applies neither.
    const one = buildRegistry({ ...EMPTY, user: [await stored(tie('tube'))] }, () => true);
    const l = one.lookup('www.youtube.com');
    assert.deepEqual(l.conflict.map((e) => e.provider.id).sort(), ['tube', 'yt']);
    assert.equal(l.entry?.provider.id, 'yt', 'the built-in stands in for the tie');
    assert.equal(normalizeMediaKey(`${W}/watch?v=abc`, one), 'yt:abc');
    assert.equal(normalizeMediaKey(`${W}/watch?v=def`, one), 'yt:def', 'every video keyed alike');
    assert.equal(normalizeMediaKey(`${W}/logout`, one), null, 'F20 reopened on YouTube');

    // With the built-in replaced by id and two others tying: nothing, not the path rule.
    const yt = JSON.parse(BUILTIN_SOURCES.find((b) => b.file === 'youtube.json')!.source) as Descriptor;
    const ytUser = { ...yt, hosts: ['youtu.be'], pageHosts: undefined, canonicalHost: 'youtu.be',
      identity: [{ path: '/{id}', key: '{id}', watch: 'https://youtu.be/{id}' }],
      examples: [{ url: 'https://youtu.be/abc', key: 'yt:abc' }] } as unknown as Descriptor;
    delete (ytUser as { pageHosts?: unknown }).pageHosts;
    const two = buildRegistry({ ...EMPTY, user: [await stored(ytUser), await stored(tie('aa')), await stored(tie('bb'))] }, () => true);
    assert.equal(two.lookup('www.youtube.com').entry, null);
    assert.equal(two.lookup('www.youtube.com').blocked, true);
    assert.equal(normalizeMediaKey(`${W}/logout`, two), null);
    assert.equal(watchUrl(`${W}/logout`, two), null);

    // Control: a tie on a host no built-in describes still falls to the generic rule.
    const a = variant({ id: 'aaa', keyPrefix: 'aaa', examples: [{ url: 'https://video.example/watch/x', key: 'aaa:/watch/x' }] });
    const b = variant({ id: 'bbb', keyPrefix: 'bbb', examples: [{ url: 'https://video.example/watch/x', key: 'bbb:/watch/x' }] });
    const free = buildRegistry({ ...EMPTY, user: [await stored(a), await stored(b)] }, () => true);
    assert.equal(free.lookup('video.example').blocked, undefined);
    assert.equal(normalizeMediaKey('https://video.example/logout', free), 'video.example:/logout');
  });

  it('decides the next episode by the descriptor in force, not a hard-coded rule (D8)', async () => {
    const ep = (s: number, e: number) => `https://laftel.net/player/${s}/${e}`;
    const key = (u: string, reg: ProviderRegistry) => normalizeMediaKey(u, reg)!;
    const lf = JSON.parse(BUILTIN_SOURCES.find((b) => b.file === 'laftel.json')!.source) as Descriptor;
    const builtins = builtinRegistry();
    assert.equal(continuesMedia(key(ep(1, 2), builtins), key(ep(1, 3), builtins), builtins), true, 'control: the built-in');

    // The user's Laftel copy says nothing continues: the room is not moved.
    const quiet = { ...lf, continues: undefined, examples: lf.examples.filter((e) => 'url' in e) };
    delete (quiet as { continues?: unknown }).continues;
    const noCont = buildRegistry({ ...EMPTY, user: [await stored(quiet)] }, () => true);
    assert.equal(continuesMedia(key(ep(1, 2), noCont), key(ep(1, 3), noCont), noCont), false);

    // A descriptor on another site says its own next episode continues.
    const series = variant({
      id: 'series', keyPrefix: 'series',
      identity: [{ path: '/watch/{show}/{n:int}', key: '/w/{show}/{n}', watch: 'https://video.example/watch/{show}/{n}' }],
      continues: [{ from: '/w/{show}/{n:int}', to: '/w/{show}/{m:int}' }],
      examples: [{ url: 'https://video.example/watch/a/1', key: 'series:/w/a/1' },
        { from: 'series:/w/a/1', to: 'series:/w/a/2', continues: true }],
    });
    const reg = buildRegistry({ ...EMPTY, user: [await stored(series)] }, () => true);
    const a1 = key('https://video.example/watch/a/1', reg);
    assert.equal(continuesMedia(a1, key('https://video.example/watch/a/2', reg), reg), true);
    assert.equal(continuesMedia(a1, key('https://video.example/watch/b/2', reg), reg), false);
    assert.equal(continuesMedia(a1, a1, reg), false);
    assert.equal(continuesMedia('series:/w/a/1', 'series:/w/a/2'), false, 'without that descriptor in force, nothing continues');

    // Two in force minting one prefix: neither is believed.
    const twin = { ...series, id: 'twin', hosts: ['other.example'], canonicalHost: 'other.example',
      identity: [{ path: '/watch/{show}/{n:int}', key: '/w/{show}/{n}', watch: 'https://other.example/watch/{show}/{n}' }],
      examples: [{ url: 'https://other.example/watch/a/1', key: 'series:/w/a/1' }] };
    const both = buildRegistry({ ...EMPTY, user: [await stored(series), await stored(twin)] }, () => true);
    assert.equal(continuesMedia('series:/w/a/1', 'series:/w/a/2', both), false);
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

describe('what a user can do with descriptors', () => {
  const SERVER = 'https://sync.example/';
  const entryFor = async (body: string, id = 'example') =>
    ({ id, name: 'X', version: '1.0.0', sha256: await sha256Hex(body), hosts: [] });

  it('saves a user descriptor, replacing one with the same id, and refuses an invalid one', async () => {
    const a = await saveUser(EMPTY, JSON.stringify(BASE));
    assert.ok(a.ok);
    assert.ok(a.changes.some((c) => c.widens), 'a descriptor nobody had widens');
    const b = await saveUser(a.state, JSON.stringify(variant({ version: '1.0.1' })));
    assert.ok(b.ok);
    assert.equal(b.state.user.length, 1);
    assert.deepEqual(b.changes.map((c) => c.field), ['version']);
    const bad = await saveUser(b.state, '{"schema":1}');
    assert.equal(bad.ok, false);
    assert.equal(removeUser(b.state, 'example').user.length, 0);
    assert.equal(EMPTY.user.length, 0, 'the input state is never mutated');
  });

  it('adopts only the bytes the index hashed', async () => {
    const body = JSON.stringify(BASE);
    const e = await entryFor(body);
    const ok = await adopt(EMPTY, SERVER, e, body, false);
    assert.ok(ok.ok);
    assert.deepEqual(ok.state.adopted.map((a) => [a.id, a.server, a.replaceBuiltin]), [['example', 'https://sync.example', false]]);
    const swapped = await adopt(EMPTY, SERVER, e, JSON.stringify(variant({ pathFallback: true })), false);
    assert.equal(swapped.ok, false, 'a file other than the one listed');
    const wrongId = await adopt(EMPTY, SERVER, { ...e, id: 'other' }, body, false);
    assert.equal(wrongId.ok, false);
  });

  it('replaces a built-in only with the user\'s confirmation, showing the difference', async () => {
    const lf = JSON.parse(BUILTIN_SOURCES.find((b) => b.file === 'laftel.json')!.source) as Descriptor;
    const body = JSON.stringify({ ...lf, version: '1.1.0', pathFallback: true,
      examples: [{ url: 'https://laftel.net/item/1', key: 'laftel:/item/1' }] });
    const e = await entryFor(body, 'laftel');
    const asked = await adopt(EMPTY, SERVER, e, body, false);
    assert.equal(asked.ok, false);
    assert.equal(!asked.ok && asked.needsReplaceConfirmation, true);
    assert.ok(!asked.ok && asked.changes?.some((c) => c.field === 'pathFallback' && c.widens));
    const yes = await adopt(EMPTY, SERVER, e, body, true);
    assert.ok(yes.ok);
    assert.equal(yes.state.adopted[0]!.replaceBuiltin, true);
    assert.equal(buildRegistry(yes.state, () => false).byId('laftel')?.tier, 'server');
    assert.equal(unadopt(yes.state, 'laftel').adopted.length, 0);
  });

  it('remembers a declined offer until the server changes it', async () => {
    const e = await entryFor('{}');
    const s = decline(EMPTY, SERVER, e);
    assert.equal(openOffers(s, SERVER, [e]).length, 0);
    const adopted = await adopt(s, SERVER, await entryFor(JSON.stringify(BASE)), JSON.stringify(BASE), false);
    assert.ok(adopted.ok);
    assert.equal(adopted.state.servers['https://sync.example']?.declined?.['example'], undefined, 'adopting clears it');
  });

  it('applies a server update by itself only when opted in and nothing widens', async () => {
    const v1 = JSON.stringify(BASE);
    const narrower = JSON.stringify(variant({ version: '1.0.1', video: { exclude: ['.ad'] } }));
    const wider = JSON.stringify(variant({ version: '1.1.0', pathFallback: true,
      examples: [{ url: 'https://video.example/x', key: 'example:/x' }] }));
    const pinned = await adopt(EMPTY, SERVER, await entryFor(v1), v1, false);
    assert.ok(pinned.ok);
    const on = setAutoAdopt(pinned.state, SERVER, true);
    const files: Record<string, string> = {};
    const fetchBody = async (id: string) => files[id]!;

    files.example = narrower;
    const a = await autoUpdate(on, SERVER, [await entryFor(narrower)], fetchBody);
    assert.deepEqual(a.applied, ['example']);
    assert.equal(a.pending.length, 0);
    assert.equal(a.state.adopted[0]!.source, narrower);

    files.example = wider;
    const b = await autoUpdate(on, SERVER, [await entryFor(wider)], fetchBody);
    assert.deepEqual(b.applied, []);
    assert.equal(b.pending.length, 1, 'a widening change waits for the user');
    assert.equal(b.state.adopted[0]!.source, v1);

    files.example = narrower;
    const off = await autoUpdate(pinned.state, SERVER, [await entryFor(narrower)], fetchBody);
    assert.deepEqual(off.applied, [], 'auto-adopt is off by default');
    assert.equal(off.pending.length, 1);

    files.example = wider; // the server lies: the index says narrower
    const lie = await autoUpdate(on, SERVER, [await entryFor(narrower)], fetchBody);
    assert.deepEqual(lie.applied, []);
  });

  it('applies an automatic update over what the user changed while it was fetching, and writes only the pin', async () => {
    const v1 = JSON.stringify(BASE);
    const narrower = JSON.stringify(variant({ version: '1.0.1', video: { exclude: ['.ad'] } }));
    const pinned = await adopt(EMPTY, SERVER, await entryFor(v1), v1, false);
    assert.ok(pinned.ok);
    const on = setAutoAdopt(pinned.state, SERVER, true);
    const index = [await entryFor(narrower)];
    const userDesc = JSON.stringify(variant({ id: 'mine', name: 'Mine', hosts: ['mine.example'],
      identity: [{ path: '/v/{id}', key: '/v/{id}', watch: 'https://mine.example/v/{id}' }],
      canonicalHost: 'mine.example', examples: [{ url: 'https://mine.example/v/a', key: 'mine:/v/a' }] }));
    const withUser = await saveUser(on, userDesc);
    assert.ok(withUser.ok);

    /** Stored state, and a user who acts while the file is being fetched. */
    async function run(start: ProviderState, meanwhile: (s: ProviderState) => ProviderState | Promise<ProviderState>) {
      const kv = new Map<string, string>();
      writeState((k, v) => kv.set(k, v), start);
      const writes: string[] = [];
      const load = (k: string, fb = '') => kv.get(k) ?? fb;
      const pending = await autoUpdateStored(() => readState(load), (k, v) => { writes.push(k); kv.set(k, v); },
        SERVER, index, async () => {
          writeState((k, v) => kv.set(k, v), await meanwhile(readState(load)));
          return narrower;
        });
      return { state: readState(load), writes, pending };
    }

    // Nobody interferes: applied, and only the pin is written.
    const plain = await run(withUser.state, (s) => s);
    assert.equal(plain.state.adopted[0]!.source, narrower);
    assert.deepEqual(plain.writes, ['providers.adopted']);
    assert.deepEqual(plain.pending, []);

    // The user deletes their own descriptor meanwhile: it stays deleted.
    const deleted = await run(withUser.state, (s) => removeUser(s, 'mine'));
    assert.equal(deleted.state.user.length, 0, 'a deleted user descriptor came back');
    assert.equal(deleted.state.adopted[0]!.source, narrower);

    // Stops using it meanwhile: not re-adopted, and nothing offered.
    const dropped = await run(withUser.state, (s) => unadopt(s, 'example'));
    assert.deepEqual(dropped.state.adopted, [], 'an unadopted descriptor came back');
    assert.deepEqual(dropped.pending, []);

    // Turns auto-adopt off meanwhile: it stays off, and the update waits.
    const off = await run(withUser.state, (s) => setAutoAdopt(s, SERVER, false));
    assert.equal(off.state.servers['https://sync.example']?.autoAdopt, false, 'auto-adopt was turned back on');
    assert.equal(off.state.adopted[0]!.source, v1);
    assert.deepEqual(off.pending.map((e) => e.id), ['example']);
  });

  it('tells a userscript user which @match lines to add', () => {
    const d = variant({ pageHosts: ['www.video.example', '*.video.example'] });
    assert.deepEqual(missingMatches(d, ['https://laftel.net/*']), [
      '// @match        https://www.video.example/*', '// @match        https://*.video.example/*',
    ]);
    assert.deepEqual(missingMatches(d, ['https://*.video.example/*']), []);
    assert.deepEqual(missingMatches(variant({}), ['https://video.example/*']), ['// @match        https://*.video.example/*'],
      'no pageHosts: every host');
  });

  it('turns granted match patterns into a host test', () => {
    const g = grantedBy(['https://*.video.example/*', 'https://exact.example/*', 'chrome://x/']);
    assert.equal(g('video.example'), true);
    assert.equal(g('www.video.example'), true);
    assert.equal(g('evilvideo.example'), false);
    assert.equal(g('exact.example'), true);
    assert.equal(g('www.exact.example'), false);
    assert.equal(grantedBy(['<all_urls>'])('anything.example'), true);
    assert.equal(grantedBy([])('video.example'), false);
  });

  it('asks for the descriptor\'s hosts and registers its pages once granted', async () => {
    const d = variant({ pageHosts: ['www.video.example'] });
    assert.deepEqual(originsFor(d), ['https://video.example/*', 'https://*.video.example/*', 'https://www.video.example/*']);
    const reg = buildRegistry({ ...EMPTY, user: [await stored(d)] }, () => false);
    assert.deepEqual(dynamicPagePatterns(reg, () => false), []);
    assert.deepEqual(dynamicPagePatterns(reg, grantedBy(originsFor(d))), ['https://www.video.example/*']);
    assert.ok(!dynamicPagePatterns(buildRegistry(EMPTY, () => true), () => true).length, 'never the built-ins');
  });
});

describe("a descriptor's capability mask on the HTML5 adapter", () => {
  class El extends EventTarget {
    currentTime = 0;
    paused = true;
    playbackRate = 1;
    readyState = 4;
    muted = false;
    volume = 1;
    duration = 100;
    buffered = { length: 0, start: () => 0, end: () => 0 };
  }
  const el = () => new El() as unknown as HTMLVideoElement;

  it('can only take capabilities away', () => {
    const plain = new Html5Adapter(el());
    assert.equal(plain.capabilities.supportsPlaybackRateNudge, true);
    assert.equal(plain.capabilities.supportsDirectSeek, true);
    const masked = new Html5Adapter(el(), 'html5', { capabilities: { playbackRateNudge: false } });
    assert.equal(masked.capabilities.supportsPlaybackRateNudge, false);
    assert.equal(masked.capabilities.supportsDirectSeek, true);
    const noSeek = new Html5Adapter(el(), 'html5', { capabilities: { directSeek: false } });
    assert.equal(noSeek.capabilities.supportsDirectSeek, false);
    // `true` in a mask grants nothing the adapter does not have.
    const asked = new Html5Adapter(el(), 'html5', { capabilities: { playbackRateNudge: true, directSeek: true } });
    assert.deepEqual(asked.capabilities, plain.capabilities);
    for (const a of [plain, masked, noSeek, asked]) a.destroy();
  });

  it('takes the seek timeout and landing tolerance from the descriptor', async () => {
    const e = el();
    const a = new Html5Adapter(e, 'html5', { seek: { timeoutMs: 1000, landingToleranceS: 2 } });
    const p = a.seekTo(10);
    // The element lands 1.5 s short: inside this provider's 2 s tolerance,
    // outside the default 0.5 s.
    e.currentTime = 8.5;
    e.dispatchEvent(new Event('seeked'));
    await p;
    const b = new Html5Adapter(e, 'html5', { seek: { timeoutMs: 1000 } });
    const t0 = Date.now();
    const q = b.seekTo(10);
    e.currentTime = 8.5;
    e.dispatchEvent(new Event('seeked'));
    await assert.rejects(q, /within 1000ms/);
    assert.ok(Date.now() - t0 < 3000, 'the descriptor timeout, not the 10 s default');
    a.destroy();
    b.destroy();
  });
});
