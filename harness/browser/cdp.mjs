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
        return { proc, port, profile, version: v['Browser'],
                 close: async () => { proc.kill('SIGKILL'); await rm(profile, { recursive: true, force: true }); } };
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
  // Evaluate an expression in the page and return its value, awaiting promises.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
    });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async waitFor(expression, { timeoutMs = 20000, everyMs = 100 } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (await this.eval(expression)) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timed out: ${expression}`);
      await sleep(everyMs);
    }
  }
  close() { try { this.ws.close(); } catch {} }
}
