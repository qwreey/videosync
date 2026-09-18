/**
 * Just enough of a DOM to mount the panel and run `start()` in node.
 *
 * The app layer is where a session meets the page -- the panel, the follow
 * timer, the rejoin record -- and it had no tests because it needed a browser.
 * It does not need much of one: elements that hold text, attributes, children
 * and listeners, a location that records `assign`, a history that records
 * `replaceState`, and a window that accepts listeners. Nothing here lays
 * anything out, so anything that depends on layout is out of reach and has to
 * be probed in `harness/browser/`.
 */

type Listener = (e: FakeEvent) => void;

/**
 * What this fake browser offers of the Popover API, for the panel's top-layer
 * path. Set before `installDom` (the panel shows its popover while it is being
 * built); `uninstall()` puts it back.
 */
export const popover = { supported: true, fails: false };

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
    // A browser with no top layer to offer: an own property shadows the
    // prototype method, so `typeof el.showPopover` is 'undefined', which is
    // what the panel feature-detects on.
    if (!popover.supported) {
      Object.assign(this, { showPopover: undefined, hidePopover: undefined });
    }
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
      toggle: (c: string, force?: boolean) => {
        const has = get().includes(c);
        const on = force === undefined ? !has : force;
        if (on !== has) set(on ? [...get(), c] : get().filter((x) => x !== c));
        return on;
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
    // The composed tree: a composed event dispatched inside the shadow root
    // bubbles on through the host and up the page, which is the whole reason
    // the panel stops key and pointer events at the root. Not in `children`,
    // so `walk()` and `getElementById` still see the light tree only.
    this.shadow.parentNode = this;
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
  /** Focus and text selection have no effect here; they only must not throw. */
  focus(): void { /* no-op */ }
  select(): void { /* no-op */ }

  contains(el: FakeElement | null): boolean {
    for (let n: FakeElement | null = el; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  // --- the top layer, as far as the panel uses it -----------------------------
  // `showPopover` throws when it is already showing, as the real one does, and
  // `popover.fails` makes it throw the way it does for a host that is not
  // connected. `topLayer` counts entries, so a test can see a re-show.
  /** How many times this element entered the top layer. */
  topLayer = 0;
  private open = false;

  showPopover(): void {
    if (this.open) throw new Error('InvalidStateError: already showing');
    if (popover.fails) throw new Error('InvalidStateError: not connected');
    this.open = true;
    this.topLayer++;
  }

  hidePopover(): void {
    if (!this.open) throw new Error('InvalidStateError: not showing');
    this.open = false;
  }

  /** `:popover-open` only; nothing else here is a selector engine. */
  matches(sel: string): boolean {
    if (sel === ':popover-open') return this.open;
    throw new Error(`fakedom: unsupported selector ${sel}`);
  }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  private readonly attrs = new Map<string, string>();

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
  /**
   * What the page has taken fullscreen, as `document.fullscreenElement`.
   * The panel does not read it -- it stays where it is and uses the top layer
   * instead -- but `setFullscreen(el)` reads better in a test than a bare
   * "fire the event".
   */
  fullscreenElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor() { this.documentElement = new FakeElement(this, 'html'); }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  querySelectorAll(_sel: string): FakeElement[] { return []; }
  getElementById(id: string): FakeElement | null {
    for (const e of this.documentElement.walk()) if (e.id === id) return e;
    return null;
  }
  addEventListener(type: string, fn: Listener): void {
    let s = this.listeners.get(type);
    if (!s) { s = new Set(); this.listeners.set(type, s); }
    s.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.get(type)?.delete(fn); }
  /** Take `el` fullscreen (or leave it, with `null`) and fire the event. */
  setFullscreen(el: FakeElement | null): void {
    this.fullscreenElement = el;
    for (const fn of [...(this.listeners.get('fullscreenchange') ?? [])]) fn({ type: 'fullscreenchange' });
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

/** `history`, as far as `replaceState` goes: it records, and moves `location`. */
export class FakeHistory {
  state: unknown = null;
  /** Every `replaceState` call, as `[state, url]`. */
  readonly replaced: Array<[unknown, string]> = [];
  private readonly location: FakeLocation;
  constructor(location: FakeLocation) { this.location = location; }
  replaceState(state: unknown, _unused: string, url?: string): void {
    this.replaced.push([state, url ?? '']);
    this.state = state;
    if (url !== undefined) this.location.href = new URL(url, this.location.href).href;
  }
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
  history: FakeHistory;
  /** What `navigator.clipboard` should be for this test. */
  setClipboard(c: { writeText(s: string): Promise<void> } | undefined): void;
  uninstall(): void;
}

/** Point the globals the app layer reads at fakes. */
export function installDom(href: string): Installed {
  const doc = new FakeDocument();
  const loc = new FakeLocation(href);
  const win = new FakeWindow(loc);
  const history = new FakeHistory(loc);
  const saved = ['document', 'window', 'location', 'history', 'navigator']
    .map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  let clipboard: { writeText(s: string): Promise<void> } | undefined;
  const define = (k: string, v: unknown) =>
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  define('document', doc);
  define('window', win);
  define('location', loc);
  define('history', history);
  define('navigator', { userAgent: 'fake', get clipboard() { return clipboard; } });
  return {
    doc, loc, win, history,
    setClipboard(c) { clipboard = c; },
    uninstall() {
      popover.supported = true;
      popover.fails = false;
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete (globalThis as Record<string, unknown>)[k];
      }
    },
  };
}
