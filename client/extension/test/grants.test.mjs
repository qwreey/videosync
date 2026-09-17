/**
 * The options page's "site permission granted" answer, against what the
 * content-script registration and the follow check actually test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { grantedBy } from '../../core/src/providers/manage.ts';
import { sitesGranted } from '../src/grants.ts';

const d = (hosts, pageHosts) => ({ hosts, ...(pageHosts ? { pageHosts } : {}) });

describe('sitesGranted', () => {
  it('does not count a wildcard host as granted by a grant of the bare domain', () => {
    // A bare grant covers no subdomain, so the button to grant the rest must show.
    const granted = grantedBy(['https://example.com/*']);
    assert.equal(granted('www.example.com'), false, 'precondition: the page host is not granted');
    assert.equal(sitesGranted(d(['example.com', '*.example.com'], ['www.example.com']), granted), false);
    assert.equal(sitesGranted(d(['example.com', '*.example.com']), granted), false);
  });

  it('counts a wildcard grant, a wider one and <all_urls>', () => {
    const desc = d(['example.com', '*.example.com'], ['www.example.com']);
    assert.equal(sitesGranted(desc, grantedBy(['https://*.example.com/*'])), true);
    assert.equal(sitesGranted(desc, grantedBy(['https://*.com/*'])), true);
    assert.equal(sitesGranted(desc, grantedBy(['<all_urls>'])), true);
    assert.equal(sitesGranted(desc, grantedBy(['https://example.com/*', 'https://www.example.com/*'])), false,
      'exact grants of some subdomains are not a grant of all of them');
  });

  it('counts exact grants of every exact host', () => {
    const granted = grantedBy(['https://example.com/*', 'https://www.example.com/*']);
    assert.equal(sitesGranted(d(['example.com'], ['www.example.com']), granted), true);
    assert.equal(sitesGranted(d(['example.com']), granted), true);
  });
});
