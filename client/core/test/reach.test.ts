/**
 * The userscript's early answer to "can this page reach that server?".
 *
 * Lives here because this is the package with a test runner; the code is the
 * userscript's, and core does not depend on it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPrivateHost, unreachable } from '../../userscript/src/reach.ts';

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0';
const YOUTUBE = { hostname: 'www.youtube.com', protocol: 'https:' };
/** What the browser hands the check: `URL.hostname`, brackets and all. */
const host = (u: string) => new URL(u).hostname;
const BLOCK = /로컬\/사설 주소로 나가는 요청을 아예 막아요/;

describe('which addresses count as private', () => {
  it('includes carrier-grade NAT, where Tailscale lives', () => {
    for (const u of ['http://100.64.0.1', 'http://100.101.102.103:8787', 'http://100.127.255.254']) {
      assert.ok(isPrivateHost(host(u)), u);
    }
    // Just outside 100.64.0.0/10.
    for (const u of ['http://100.63.255.255', 'http://100.128.0.1', 'http://99.64.0.1']) {
      assert.ok(!isPrivateHost(host(u)), u);
    }
  });

  it('includes IPv6 unique-local and link-local addresses', () => {
    for (const u of ['http://[fd7a:115c:a1e0::1]:8787', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[febf::1]', 'http://[::1]']) {
      assert.ok(isPrivateHost(host(u)), u);
    }
    for (const u of ['http://[2001:db8::1]', 'http://[fec0::1]', 'http://[ff02::1]']) {
      assert.ok(!isPrivateHost(host(u)), u);
    }
  });

  it('sees through an IPv4-mapped IPv6 address', () => {
    // `new URL` rewrites the dotted tail into hex: [::ffff:a00:1].
    assert.ok(isPrivateHost(host('http://[::ffff:10.0.0.1]')));
    assert.ok(isPrivateHost(host('http://[::ffff:127.0.0.1]')));
    assert.ok(!isPrivateHost(host('http://[::ffff:8.8.8.8]')));
  });

  it('still includes what it always did', () => {
    for (const u of ['http://localhost:8787', 'http://127.0.0.1', 'http://192.168.1.5', 'http://172.16.0.1', 'http://nas.local']) {
      assert.ok(isPrivateHost(host(u)), u);
    }
    assert.ok(!isPrivateHost('sync.example.com'));
  });
});

describe('a server the page cannot reach', () => {
  it('is caught early on Chromium, for a Tailscale address too', () => {
    for (const s of ['http://127.0.0.1:8787', 'https://192.168.1.5', 'http://100.101.102.103:8787', 'https://[fd7a:115c:a1e0::1]']) {
      assert.match(unreachable(s, YOUTUBE, CHROME) ?? '', BLOCK, s);
    }
  });

  it('is not claimed on Firefox, which was measured to let a public page reach loopback', () => {
    // BROWSER-FINDINGS §19: an https YouTube page's socket to ws://127.0.0.1
    // arrived as a plain GET. That address is the measured one.
    assert.equal(unreachable('http://127.0.0.1:8787', YOUTUBE, FIREFOX), null);
    // Not measured from a page; let through because a false refusal stops the
    // member outright and a false pass only costs the browser's silence.
    for (const s of ['http://localhost:8787', 'http://[::1]:8787']) {
      assert.equal(unreachable(s, YOUTUBE, FIREFOX), null, s);
    }
    // Firefox was not measured to block a private address, so nothing may
    // say that it does. A plaintext LAN server from an https page is still
    // mixed content, and still refused for that reason.
    assert.equal(unreachable('https://192.168.1.5', YOUTUBE, FIREFOX), null);
    const lan = unreachable('http://192.168.1.5:8787', YOUTUBE, FIREFOX);
    assert.ok(lan);
    assert.doesNotMatch(lan, BLOCK);
  });

  it('is fine from a private page, and a public server is fine from anywhere', () => {
    const lanPage = { hostname: '192.168.1.2', protocol: 'http:' };
    for (const ua of [CHROME, FIREFOX]) {
      assert.equal(unreachable('http://192.168.1.5:8787', lanPage, ua), null);
      assert.equal(unreachable('https://sync.example.com', YOUTUBE, ua), null);
      assert.match(unreachable('http://sync.example.com', YOUTUBE, ua) ?? '', /https/);
    }
  });
});
