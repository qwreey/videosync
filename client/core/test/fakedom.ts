/**
 * Just enough of a DOM to mount the panel and run `start()` in node.
 *
 * The app layer is where a session meets the page -- the panel, the follow
 * timer, the rejoin record -- and it had no tests because it needed a browser.
 * It does not need much of one: elements that hold text, attributes, children
 * and listeners, a location that records `assign`, and a window that accepts
 * listeners. Nothing here lays anything out, so anything that depends on
 * layout is out of reach and has to be probed in `harness/browser/`.
 */

type Listener = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target?: FakeElement;
  [k: string]: unknown;
}

export class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private text = '';
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly style: Record<string, string> = {};
  id = '';
  className = '';
  placeholder = '';
  value = '';
  title = '';
  disabled = false;
  scrollTop = 0;
  readonly scrollHeight = 0;
  onclick: ((e: FakeEvent) => void) | null = null;
  shadow: FakeElement | null = null;
  shadowMode = '';
  readonly captured: number[] = [];

  constructor(doc: FakeDocument, tag: string) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(t: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.text = t;
  }

  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (xs: string[]) => { this.className = xs.join(' '); };
    return {
      contains: (c: string) => get().includes(c),
      add: (c: string) => { if (!get().includes(c)) set([...get(), c]); },
      remove: (c: string) => { set(get().filter((x) => x !== c)); },
      toggle: (c: string) => {
        const has = get().includes(c);
        set(has ? get().filter((x) => x !== c) : [...get(), c]);
        return !has;
      },
    };
  }

  append(...kids: FakeElement[]): void {
    for (const k of kids) {
      k.remove();
      k.parentNode = this;
      this.children.push(k);
    }
  }

  remove(): void {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }

  get childElementCount(): number { return this.children.length; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }

  attachShadow(o: { mode: string }): FakeElement {
    this.shadowMode = o.mode;
    this.shadow = new FakeElement(this.ownerDocument, '#shadow-root');
    return this.shadow;
  }

  addEventListener(type: string, fn: Listener): void {
    let s = this.listeners.get(type);
    if (!s) { s = new Set(); this.listeners.set(type, s); }
    s.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void { this.listeners.get(type)?.delete(fn); }

  /** Bubbles to the ancestors, the way every event this panel listens to does. */
  dispatchEvent(e: FakeEvent): void {
    e.target ??= this;
    let stopped = false;
    const ev = Object.assign(e, { stopPropagation: () => { stopped = true; } });
    for (let n: FakeElement | null = this; n && !stopped; n = n.parentNode) {
      for (const fn of [...(n.listeners.get(e.type) ?? [])]) fn(ev);
      if (e.type === 'click' && n.onclick) n.onclick(ev);
    }
  }

  click(): void { this.dispatchEvent({ type: 'click' }); }

  /** Tag-name selectors only. */
  closest(sel: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parentNode) {
      if (n.tagName === sel.toUpperCase()) return n;
    }
    return null;
  }

  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  setPointerCapture(id: number): void { this.captured.push(id); }

  /** Every descendant, in document order. */
  *walk(): Generator<FakeElement> {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }

  /** Whether nothing between here and the root is `display: none`. */
  get shown(): boolean {
    for (let n: FakeElement | null = this; n; n = n.parentNode) {
      if (n.style['display'] === 'none') return false;
    }
    return true;
  }
}

export class FakeDocument {
  readonly documentElement: FakeElement;
  hidden = false;
  constructor() { this.documentElement = new FakeElement(this, 'html'); }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  querySelectorAll(_sel: string): FakeElement[] { return []; }
  getElementById(id: string): FakeElement | null {
    for (const e of this.documentElement.walk()) if (e.id === id) return e;
    return null;
  }
}

export class FakeLocation {
  private url: URL;
  /** Every `assign` call. The page is not actually replaced. */
  readonly assigned: string[] = [];
  constructor(href: string) { this.url = new URL(href); }
  get href(): string { return this.url.href; }
  set href(h: string) { this.url = new URL(h); }
  get hash(): string { return this.url.hash; }
  get hostname(): string { return this.url.hostname; }
  get protocol(): string { return this.url.protocol; }
  get pathname(): string { return this.url.pathname; }
  get origin(): string { return this.url.origin; }
  assign(h: string): void { this.assigned.push(h); }
  toString(): string { return this.href; }
}

export class FakeWindow {
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly location: FakeLocation;
  constructor(location: FakeLocation) { this.location = location; }
  addEventListener(t: string, fn: () => void): void {
    let s = this.listeners.get(t);
    if (!s) { s = new Set(); this.listeners.set(t, s); }
    s.add(fn);
  }
  removeEventListener(t: string, fn: () => void): void { this.listeners.get(t)?.delete(fn); }
}

export interface Installed {
  doc: FakeDocument;
  loc: FakeLocation;
  win: FakeWindow;
  /** What `navigator.clipboard` should be for this test. */
  setClipboard(c: { writeText(s: string): Promise<void> } | undefined): void;
  uninstall(): void;
}

/** Point the globals the app layer reads at fakes. */
export function installDom(href: string): Installed {
  const doc = new FakeDocument();
  const loc = new FakeLocation(href);
  const win = new FakeWindow(loc);
  const saved = ['document', 'window', 'location', 'navigator']
    .map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  let clipboard: { writeText(s: string): Promise<void> } | undefined;
  const define = (k: string, v: unknown) =>
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define('document', doc);
  define('window', win);
  define('location', loc);
  define('navigator', { userAgent: 'fake', get clipboard() { return clipboard; } });
  return {
    doc, loc, win,
    setClipboard(c) { clipboard = c; },
    uninstall() {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete (globalThis as Record<string, unknown>)[k];
      }
    },
  };
}
