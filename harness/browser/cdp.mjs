// Minimal CDP client. Node 26 has a global WebSocket, so no dependencies --
// which matters: this repo's whole point is that a self-hoster can build it.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, extraFlags = [], headful = false } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'vs-chrome-'));
  const flags = [
    // Headless Chrome may not implement renderer backgrounding at all, so any
    // throttling measurement taken in it is unfalsifiable. headful (under
    // Xvfb) is the cross-check.
    ...(headful ? [] : ['--headless=new']),
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    ...extraFlags,
    'about:blank',
  ];
  const proc = spawn(process.env.CHROME_BIN || 'chromium', flags, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(headful ? { DISPLAY: process.env.DISPLAY || ':99' } : {}) },
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });

  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const v = await r.json();
        return {
          proc, port, profile, version: v['Browser'],
          // Chrome keeps writing to its profile for a moment after SIGKILL, so
          // removing it immediately races and throws ENOTEMPTY -- after every
          // measurement is already taken, which turned a clean run into a
          // non-zero exit and looked like the probe had failed. Wait for the
          // process to actually go, then remove, then give up quietly: a
          // leftover temp directory is not worth failing a run over.
          close: async () => {
            proc.kill('SIGKILL');
            await new Promise((res) => {
              if (proc.exitCode !== null || proc.signalCode !== null) return res();
              proc.once('exit', res);
              setTimeout(res, 2000);
            });
            for (let attempt = 0; attempt < 5; attempt++) {
              try { await rm(profile, { recursive: true, force: true }); return; } catch {}
              await sleep(200);
            }
          },
        };
      }
    } catch {}
    await sleep(100);
  }
  proc.kill('SIGKILL');
  throw new Error(`chromium did not expose CDP on ${port}\n${stderr.slice(-800)}`);
}

export async function newTab(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`newTab failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export class Session {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((f) => f(msg.params));
      }
    };
    return this;
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /**
   * Track execution contexts so an extension's ISOLATED world can be addressed.
   *
   * A content script does not share globals with the page -- that is the whole
   * point of an isolated world -- so `Runtime.evaluate` with no contextId
   * cannot see anything the extension defined. Driving the extension therefore
   * means finding its context and evaluating in it, rather than adding a
   * postMessage command channel to the content script, which would let any
   * page drive the extension.
   */
  trackContexts() {
    this.contexts = new Map();
    this.on('Runtime.executionContextCreated', (p) => {
      this.contexts.set(p.context.id, p.context);
    });
    this.on('Runtime.executionContextDestroyed', (p) => {
      this.contexts.delete(p.executionContextId);
    });
    this.on('Runtime.executionContextsCleared', () => { this.contexts.clear(); });
  }

  /**
   * The content script's isolated world: the most recently created one, or,
   * when `isolatedName` is set, the most recent one with that name.
   *
   * "Most recent" is only right when ours is the sole extension. A real
   * browser has others -- Helium ships uBlock Origin, which injects two
   * isolated worlds into every page -- and the unfiltered pick lands in one of
   * those and reports "VideoSync is not defined". A context's name is the
   * extension's manifest name.
   */
  isolatedContextId() {
    if (!this.contexts) return null;
    let best = null;
    for (const [id, c] of this.contexts) {
      if (!c.auxData || c.auxData.isDefault !== false) continue;
      if (this.isolatedName && c.name !== this.isolatedName) continue;
      best = id;
    }
    return best;
  }

  /**
   * Evaluate in whatever isolated world exists RIGHT NOW.
   *
   * Caching the id does not survive a navigation: the context is destroyed and
   * a new one created, and every later call fails with "Cannot find context
   * with specified id". Resolving it per call costs nothing and removes a whole
   * class of flake.
   */
  async evalIsolated(expression, { timeoutMs = 30000 } = {}) {
    const id = await this.waitForIsolated({ timeoutMs });
    try {
      return await this.eval(expression, id);
    } catch (e) {
      if (!/Cannot find context/.test(String(e.message))) throw e;
      // It went away between resolving and using it. Once more, freshly.
      return this.eval(expression, await this.waitForIsolated({ timeoutMs }));
    }
  }

  async waitForIsolated({ timeoutMs = 30000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const id = this.isolatedContextId();
      if (id !== null) return id;
      if (Date.now() - t0 > timeoutMs) throw new Error('no isolated world appeared (did the content script run?)');
      await sleep(100);
    }
  }

  // Evaluate an expression in the page and return its value, awaiting promises.
  // `contextId` targets a specific world; omit it for the page's own.
  async eval(expression, contextId) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
      ...(contextId === undefined ? {} : { contextId }),
    });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async waitFor(expression, { timeoutMs = 20000, everyMs = 100, contextId, isolated = false } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = isolated ? await this.evalIsolated(expression) : await this.eval(expression, contextId);
      if (v) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timed out: ${expression}`);
      await sleep(everyMs);
    }
  }
  close() { try { this.ws.close(); } catch {} }
}
