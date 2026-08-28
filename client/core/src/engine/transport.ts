/**
 * The socket, behind an interface.
 *
 * The engine must be drivable without a browser and without a network: the
 * unit tests script a fake transport, and the end-to-end test drives the real
 * one against a real `videosyncd`. Nothing in the engine may touch `WebSocket`
 * directly.
 */
import type { ClientFrame, ServerFrame } from './protocol.ts';

export interface TransportHandlers {
  onOpen(): void;
  onFrame(f: ServerFrame): void;
  /** `clean` distinguishes "we closed it" from "it died". */
  onClose(clean: boolean, reason: string): void;
}

export interface Transport {
  connect(h: TransportHandlers): void;
  send(f: ClientFrame): void;
  /** Idempotent. Must not invoke onClose with clean=false. */
  close(): void;
}

/** The real one. `WebSocket` is global in browsers and in Node >= 22. */
export class WebSocketTransport implements Transport {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private closing = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(h: TransportHandlers): void {
    this.closing = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => h.onOpen());
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // malformed frame: ignore, do not tear the session down
      }
      if (typeof parsed === 'object' && parsed !== null && 't' in parsed) {
        h.onFrame(parsed as ServerFrame);
      }
    });
    const done = (reason: string) => {
      if (this.ws !== ws) return;
      this.ws = null;
      h.onClose(this.closing, reason);
    };
    ws.addEventListener('close', (ev: CloseEvent) => done(`${ev.code} ${ev.reason}`));
    ws.addEventListener('error', () => done('socket error'));
  }

  send(f: ClientFrame): void {
    // readyState 1 is OPEN. Sending on a socket that is not open throws in
    // browsers, and a throw here would propagate into a timer callback.
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(f));
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }
}
