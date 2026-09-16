// Minimal WebDriver BiDi client, for Firefox -- which removed CDP in 129.
// Same stance as cdp.mjs: Node's global WebSocket, no dependencies.
//
// Firefox exposes no way to evaluate inside an extension's content script, so
// a probe drives the extension the way a user does: through the panel, whose
// open shadow root the page can reach, and reads results off the page.

export class Bidi {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }

  static async connect(port = 9223) {
    const b = new Bidi(`ws://127.0.0.1:${port}/session`);
    b.ws = new WebSocket(b.url);
    await new Promise((res, rej) => { b.ws.onopen = res; b.ws.onerror = rej; });
    b.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined && b.pending.has(msg.id)) {
        const { res, rej } = b.pending.get(msg.id);
        b.pending.delete(msg.id);
        msg.type === 'error' ? rej(new Error(`${msg.error}: ${msg.message}`)) : res(msg.result);
      } else if (msg.type === 'event') {
        (b.listeners.get(msg.method) || []).forEach((f) => f(msg.params));
      }
    };
    await b.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    return b;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  async installExtension(path) {
    return (await this.send('webExtension.install', { extensionData: { type: 'path', path } })).extension;
  }

  async newTab(url) {
    const { context } = await this.send('browsingContext.create', { type: 'window' });
    if (url) await this.navigate(context, url);
    return context;
  }

  navigate(context, url, wait = 'complete') {
    return this.send('browsingContext.navigate', { context, url, wait });
  }

  /** Evaluate in the page's own realm and return a plain value. */
  async eval(context, expression) {
    const r = await this.send('script.evaluate', {
      expression, target: { context }, awaitPromise: true, resultOwnership: 'none',
      serializationOptions: { maxObjectDepth: 6 },
    });
    if (r.type === 'exception') throw new Error(`page threw: ${r.exceptionDetails.text}`);
    return deserialize(r.result);
  }

  async waitFor(context, expression, { timeoutMs = 20000, everyMs = 200 } = {}) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.eval(context, expression)) return; } catch { /* navigating */ }
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timed out: ${expression}`);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  /**
   * End the session, then the socket. Firefox allows one session at a time and
   * does not end it when the socket drops, so a probe that only closed the
   * socket locked the browser out of every later run.
   */
  async close() {
    try { await Promise.race([this.send('session.end'), new Promise((r) => setTimeout(r, 1000))]); } catch {}
    try { this.ws.close(); } catch {}
  }
}

/** BiDi's remote-value encoding back to plain JS. */
export function deserialize(v) {
  switch (v?.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return v.value;
    case 'number': return typeof v.value === 'string' ? Number(v.value) : v.value;
    case 'array': return v.value.map(deserialize);
    case 'object': return Object.fromEntries(v.value.map(([k, x]) => [typeof k === 'string' ? k : deserialize(k), deserialize(x)]));
    default: return v?.value ?? null;
  }
}
