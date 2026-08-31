import type { ClientFrame } from '@videosync/core/engine/protocol.ts';
import type { Transport, TransportHandlers } from '@videosync/core/engine/transport.ts';

import { PORT_NAME } from './relay.ts';
import type { FromWorker, ToWorker } from './relay.ts';

/**
 * A Transport whose socket is somewhere else.
 *
 * The engine cannot tell the difference, which is the point: the extension
 * reuses the entire client core unchanged and differs from the userscript in
 * this one class.
 *
 * A dropped port is reported as an unclean close, so the engine's existing
 * reconnect path handles a torn-down service worker the same way it handles a
 * dropped network -- back off, reconnect, throw the clock estimate away. That
 * makes worker teardown a degradation rather than a broken session, which is
 * worth more than the measurement saying it does not happen (§10).
 */
export class PortTransport implements Transport {
  private readonly url: string;
  private port: chrome.runtime.Port | null = null;
  private closing = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(h: TransportHandlers): void {
    this.closing = false;
    const port = chrome.runtime.connect({ name: PORT_NAME });
    this.port = port;
    port.onMessage.addListener((m: FromWorker) => {
      if (this.port !== port) return;
      switch (m.t) {
        case 'open.ok': h.onOpen(); break;
        case 'frame': h.onFrame(m.frame); break;
        case 'closed':
          this.port = null;
          try { port.disconnect(); } catch { /* already gone */ }
          h.onClose(this.closing || m.clean, m.reason);
          break;
        default: break;
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      // The worker went away mid-session. Unclean unless we asked for it.
      h.onClose(this.closing, chrome.runtime.lastError?.message ?? 'worker disconnected');
    });
    this.post(port, { t: 'open', url: this.url });
  }

  send(f: ClientFrame): void {
    if (this.port) this.post(this.port, { t: 'send', frame: f });
  }

  close(): void {
    this.closing = true;
    const port = this.port;
    this.port = null;
    if (!port) return;
    this.post(port, { t: 'close' });
    try { port.disconnect(); } catch { /* already gone */ }
  }

  /** postMessage throws once the other end is gone; that is a close, not a crash. */
  private post(port: chrome.runtime.Port, m: ToWorker): void {
    try { port.postMessage(m); } catch { this.port = null; }
  }
}
