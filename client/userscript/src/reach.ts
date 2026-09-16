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
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return h === '0.0.0.0';
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
 */
export function unreachable(serverUrl: string, page: PageLocation, _userAgent: string): string | null {
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
  if (!isPrivateHost(page.hostname) && isPrivateHost(u.hostname)) {
    return '브라우저가 이 페이지에서 로컬/사설 주소로 나가는 요청을 아예 막아요 (스킴과 무관해요). ' +
      '서버를 공개 주소 + 실제 인증서로 두거나, 터널을 쓰거나, 확장 프로그램 쪽을 쓰세요 — ' +
      '확장의 서비스 워커는 이 제한을 받지 않아요.';
  }
  if (page.protocol === 'https:' && u.protocol === 'http:') {
    return '이 페이지는 https라서 http 서버에는 연결할 수 없어요. ' +
      '서버에 TLS를 붙이거나(-tls-cert/-tls-key), TLS를 종단하는 리버스 프록시 뒤에 두세요.';
  }
  return null;
}
