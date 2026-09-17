/** The generated metadata block. No browser, no userscript manager. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBuiltins, matchPatterns } from '../core/scripts/providers.mjs';
import { PLACEHOLDER, renderMeta } from './meta.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, 'meta.txt'), 'utf8');
const patterns = matchPatterns(loadBuiltins());

describe('the userscript metadata block', () => {
  it('matches exactly the built-in descriptors\' pages', () => {
    const meta = renderMeta(template, patterns);
    const matches = meta.split('\n').filter((l) => l.startsWith('// @match ')).map((l) => l.split(/\s+/)[2]);
    assert.deepEqual(matches, patterns);
    assert.ok(!meta.includes(PLACEHOLDER));
    assert.ok(!template.split('\n').some((l) => l.startsWith('// @match ')), 'meta.txt must not keep its own list');
  });

  it('keeps the block well-formed and the grants the script needs', () => {
    const meta = renderMeta(template, patterns);
    const lines = meta.split('\n');
    const start = lines.indexOf('// ==UserScript==');
    const end = lines.indexOf('// ==/UserScript==');
    assert.ok(start === 0 && end > start);
    const matchAt = lines.findIndex((l) => l.startsWith('// @match '));
    assert.ok(matchAt > start && matchAt < end, 'the @match lines are inside the block');
    for (const g of ['GM_getValue', 'GM_setValue', 'GM_registerMenuCommand']) {
      assert.ok(lines.some((l) => l.startsWith('// @grant') && l.endsWith(g)), g);
    }
    const block = lines.slice(start, end);
    assert.ok(!block.some((l) => /^\/\/ @grant\s+none/.test(l)), '@grant none would put the script under the page CSP');
  });

  it('asks Violentmonkey for the content-script world, whatever its default (N14)', () => {
    // Violentmonkey's default, `auto`, runs a granted script in the page's own
    // JS realm: window.VideoSync (and with it panelRoot()), the page's JSON
    // around the device tokens, and the site's CSP around the socket.
    const block = renderMeta(template, patterns).split('\n');
    const inject = block.filter((l) => /^\/\/ @inject-into\b/.test(l));
    assert.deepEqual(inject.map((l) => l.split(/\s+/)[2]), ['content']);
  });

  it('refuses a template without the placeholder', () => {
    assert.throws(() => renderMeta('// ==UserScript==\n// ==/UserScript==', patterns));
  });
});
