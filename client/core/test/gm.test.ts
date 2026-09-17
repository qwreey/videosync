/**
 * The userscript's HTTP over `GM_xmlhttpRequest`, against a fake of it.
 *
 * Lives here because this is the package with a test runner; the code is the
 * userscript's, and core does not depend on it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gatewayWantsLogin } from '../src/app/auth.ts';
import { gmRequest } from '../../userscript/src/gmxhr.ts';
import type { GmDetails, GmResponse } from '../../userscript/src/gmxhr.ts';

const URL_ = 'https://sync.example/api/session';
const INIT = { method: 'GET', headers: {} };

/** A `GM_xmlhttpRequest` that answers with `settle(details)`. */
function gm(settle: (d: GmDetails) => void) {
  const seen: GmDetails[] = [];
  const xhr = (d: GmDetails) => { seen.push(d); queueMicrotask(() => settle(d)); };
  return { seen, xhr };
}

const load = (r: GmResponse) => gm((d) => d.onload?.(r));

describe('gmRequest', () => {
  it('asks for redirects not to be followed', async () => {
    const g = load({ status: 200, finalUrl: URL_ });
    await gmRequest(g.xhr, URL_, INIT);
    assert.equal(g.seen[0]!.redirect, 'manual');
  });

  it('reads an answer as it came', async () => {
    const r = await gmRequest(load({
      status: 401, finalUrl: URL_, responseText: '{"error":"x"}',
      responseHeaders: 'x-a: b\r\nContent-Type: application/json\r\n',
    }).xhr, URL_, INIT);
    assert.deepEqual(r, { status: 401, body: '{"error":"x"}', contentType: 'application/json', redirected: false });
  });

  it('names a redirect it saw', async () => {
    for (const res of [{ status: 302, finalUrl: URL_ }, { status: 200, finalUrl: 'https://login.example/' }]) {
      const r = await gmRequest(load(res).xhr, URL_, INIT);
      assert.equal(r.redirected, true, JSON.stringify(res));
    }
  });

  // How Tampermonkey answers `redirect: 'manual'` is unmeasured. If it is as
  // `fetch`'s opaque redirect -- status 0, the URL unchanged -- this is the
  // only sign of a gateway login there is.
  it('takes a completed answer with no status for a redirect', async () => {
    for (const res of [{ status: 0 }, { status: 0, finalUrl: URL_ }]) {
      const r = await gmRequest(load(res).xhr, URL_, INIT);
      assert.equal(r.redirected, true, JSON.stringify(res));
      assert.ok(gatewayWantsLogin(r.status, r.redirected), 'a gateway login goes unrecognised');
    }
  });

  it('never takes a request that failed for a redirect', async () => {
    const fails: Array<[string, (d: GmDetails) => void]> = [
      ['error', (d) => d.onerror?.({ status: 0, finalUrl: URL_ })],
      ['timeout', (d) => d.ontimeout?.()],
      ['abort', (d) => d.onabort?.()],
    ];
    for (const [name, settle] of fails) {
      await assert.rejects(gmRequest(gm(settle).xhr, URL_, INIT), Error, name);
    }
  });
});
