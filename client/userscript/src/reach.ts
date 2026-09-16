/**
 * Whether a server can be reached from the page this script runs on.
 *
 * Kept apart from `main.ts`, which starts the app as soon as it is imported,
 * so the answer can be tested without a browser (`client/core/test/reach.test.ts`).
 */

/** The parts of `location` the answer depends on. */
export interface PageLocation {
  hostname: string;
  protocol: string;
}

/**
 * Is this hostname in a private address space?
 *
 * Not exhaustive and does not need to be -- it exists to catch the common
 * self-hosting mistake early and say why, not to be a security boundary. A
 * name that resolves privately but does not look private will still fail, just
 * with the browser's silence instead of ours.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = unmapIPv4(hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  if (isLoopback(h) || h.endsWith('.local')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // 100.64.0.0/10, carrier-grade NAT -- where Tailscale and its kin put every
  // node, so a self-hosted server reached over one lands here.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  // fc00::/7 (unique-local, Tailscale's IPv6 among them) and fe80::/10. A
  // first group this large is always written with four digits.
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  return h === '0.0.0.0';
}

/** `localhost` and the loopback literals, already lower-case and unbracketed. */
function isLoopback(h: string): boolean {
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** `new URL` writes `[::ffff:10.0.0.1]` as `::ffff:a00:1`; give back the IPv4. */
function unmapIPv4(h: string): string {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!m) return h;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Why this server is unreachable from this page, if it is.
 *
 * Measured (docs/BROWSER-FINDINGS.md §8): from a page on a public origin a
 * request to a loopback or private address is refused **before it is sent** --
 * any scheme, http and https and ws and wss alike -- and a plaintext server is
 * additionally unreachable from an https page. Neither failure produces a
 * useful error: the request simply never settles, which looks exactly like a
 * server that is down. Catching it here is the difference between one sentence
 * and an evening.
 *
 * The extension does not share this limit: its service worker is exempt, which
 * is the one thing it can do that a userscript structurally cannot.
 *
 * That block is Chromium's. Firefox was measured NOT to apply it: an https
 * YouTube page's socket to `ws://127.0.0.1` arrived as a plain GET (§19). So on
 * Firefox nothing here claims a block, and loopback -- which is not mixed
 * content there -- is let through. Firefox and a LAN address was not
 * measured, and saying nothing is better than saying something false: the
 * cost is the browser's silence if it does block. Any other engine keeps the
 * Chromium answer, which is the only one measured to be refused.
 */
export function unreachable(serverUrl: string, page: PageLocation, userAgent: string): string | null {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return '서버 주소를 이해할 수 없어요. http:// 나 https:// 로 시작해야 해요.';
  }
  // `new URL('localhost:8787')` PARSES -- scheme `localhost:`, opaque path --
  // so returning null here declared it reachable and the failure surfaced much
  // later, as nothing happening at all.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return '서버 주소는 http:// 나 https:// 로 시작해야 해요.';
  }
  // The block keys off the page's ADDRESS SPACE, not its scheme: an http page
  // on a public host is still public, and Chrome still refuses. Using the
  // scheme as a proxy would let exactly the case this function exists to catch
  // -- an http OTT site pointed at a LAN server -- straight through.
  const firefox = /\bFirefox\//.test(userAgent);
  if (!firefox && !isPrivateHost(page.hostname) && isPrivateHost(u.hostname)) {
    return '브라우저가 이 페이지에서 로컬/사설 주소로 나가는 요청을 아예 막아요 (스킴과 무관해요). ' +
      '서버를 공개 주소 + 실제 인증서로 두거나, 터널을 쓰거나, 확장 프로그램 쪽을 쓰세요 — ' +
      '확장의 서비스 워커는 이 제한을 받지 않아요.';
  }
  // Only what §19 covered: a `*.localhost` name is loopback to Chromium, but
  // was not measured to be exempt from mixed content in Firefox.
  const sh = unmapIPv4(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  const loopback = isLoopback(sh) && !sh.endsWith('.localhost');
  if (page.protocol === 'https:' && u.protocol === 'http:' && !(firefox && loopback)) {
    return '이 페이지는 https라서 http 서버에는 연결할 수 없어요. ' +
      '서버에 TLS를 붙이거나(-tls-cert/-tls-key), TLS를 종단하는 리버스 프록시 뒤에 두세요.';
  }
  return null;
}
