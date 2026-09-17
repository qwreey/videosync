/**
 * The manifests the build writes. No browser: this checks that the host list
 * comes from the descriptors and that the permissions are what the design
 * says, because a manifest edit is exactly the kind of change nobody reruns a
 * live probe for.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBuiltins, matchPatterns } from '../core/scripts/providers.mjs';
import { chromeManifest, firefoxManifest } from './manifest.mjs';

// `mise run test` names this file alone; the shim's other no-browser tests
// run with it, so each is imported here (`npm test` runs the same file).
import './test/grants.test.mjs';
import './test/tokens.test.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const patterns = matchPatterns(loadBuiltins());

describe('the extension manifests', () => {
  it('run on exactly the built-in descriptors\' pages', () => {
    const c = chromeManifest(base, patterns);
    assert.deepEqual(c.content_scripts[0].matches, patterns);
    assert.ok(patterns.includes('https://laftel.net/*'));
    assert.ok(patterns.includes('https://www.youtube.com/*'));
    assert.deepEqual(base.content_scripts[0].matches, [], 'the source manifest must not keep its own list');
  });

  it('ask for no host at install, and for new hosts only as optional ones', () => {
    const c = chromeManifest(base, patterns);
    assert.equal(c.manifest_version, 3);
    assert.equal(c.host_permissions, undefined, 'measured unnecessary (BROWSER-FINDINGS §11)');
    assert.deepEqual(c.optional_host_permissions, ['https://*/*']);
    assert.deepEqual([...c.permissions].sort(), ['scripting', 'storage']);
    assert.equal(c.options_ui.page, 'options.html');
  });

  it('keep the Firefox build on Manifest V2 with the same pages', () => {
    const f = firefoxManifest(base, patterns);
    assert.equal(f.manifest_version, 2);
    assert.deepEqual(f.content_scripts, chromeManifest(base, patterns).content_scripts);
    assert.deepEqual(f.optional_permissions, ['https://*/*']);
    assert.equal(f.optional_host_permissions, undefined, 'MV3-only key');
    assert.deepEqual(f.background, { scripts: ['sw.js'], persistent: false });
    assert.equal(f.options_ui.page, 'options.html');
    assert.equal(f.browser_specific_settings.gecko.strict_min_version, '128.0');
  });
});
