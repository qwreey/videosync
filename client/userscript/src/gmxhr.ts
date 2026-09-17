/**
 * `RawHttp` over `GM_xmlhttpRequest`, which is passed in.
 *
 * Kept apart from `gm.ts`, which imports core through the bundler's alias, so
 * it can be tested without a browser (`client/core/test/gm.test.ts`).
 */
import type { HttpResult, RawHttp } from '../../core/src/app/authfetch.ts';

export interface GmResponse {
  status: number;
  responseText?: string;
  responseHeaders?: string;
  finalUrl?: string;
}

export interface GmDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  anonymous?: boolean;
  redirect?: 'follow' | 'error' | 'manual';
  timeout?: number;
  onload?: (r: GmResponse) => void;
  onerror?: (r: unknown) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}

export type GmXhr = (d: GmDetails) => unknown;

/**
 * No CORS, no page CSP, and not the page's cookies (`anonymous`). A request
 * that fails comes back through `onerror`, `ontimeout` or `onabort`, never
 * `onload`.
 */
export function gmRequest(xhr: GmXhr, url: string, init: Parameters<RawHttp>[1]): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    xhr({
      method: init.method,
      url,
      headers: init.headers,
      ...(init.body !== undefined ? { data: init.body } : {}),
      anonymous: true,
      redirect: 'manual',
      timeout: 15_000,
      onload: (r) => {
        const type = /^content-type:\s*(.*)$/im.exec(r.responseHeaders ?? '')?.[1]?.trim() ?? '';
        resolve({
          status: r.status,
          body: r.responseText ?? '',
          contentType: type,
          // How Tampermonkey answers `redirect: 'manual'` is unmeasured
          // (docs/design/auth.md). It may be as `fetch`'s opaque redirect:
          // status 0 and the URL unchanged. A failure never lands here, so a
          // completed answer with no status has no other reading, and not
          // taking it for one leaves a gateway's login unrecognised.
          redirected: r.status === 0 || (r.status >= 300 && r.status < 400)
            || (!!r.finalUrl && r.finalUrl !== url),
        });
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timed out')),
      onabort: () => reject(new Error('aborted')),
    });
  });
}
