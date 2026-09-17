/**
 * Just enough DOM for options.ts, which builds everything with createElement,
 * setAttribute, addEventListener, append and textContent. No layout, no event
 * propagation: a test fires a listener on the element it names, and asks
 * `isConnected` whether a browser would still deliver a click there.
 */

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.files = null;
    this.ownText = '';
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, f) { (this.listeners[type] ??= []).push(f); }
  append(...kids) {
    for (const k of kids) {
      const node = typeof k === 'string' ? new FakeText(k) : k;
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
      node.parent = this;
      this.children.push(node);
    }
  }
  set textContent(t) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.ownText = String(t);
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n.isRoot === true;
  }
  scrollIntoView() {}
  /** Every element below this one, depth first. */
  *walk() {
    for (const c of this.children) {
      if (c instanceof FakeElement) { yield c; yield* c.walk(); }
    }
  }
}

class FakeText {
  constructor(t) { this.text = t; this.parent = null; }
  get textContent() { return this.text; }
}

export function fakeDocument() {
  const root = new FakeElement('html');
  root.isRoot = true;
  const app = new FakeElement('div');
  app.attrs.id = 'app';
  root.append(app);
  const document = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => [root, ...root.walk()].find((e) => e.attrs.id === id) ?? null,
  };
  return { document, app };
}

/** Run `type`'s listeners on `el` and wait for what they started. */
export async function fire(el, type) {
  await Promise.all((el.listeners[type] ?? []).map((f) => f({ type, target: el })));
  await settle();
}

/** Let chained promises and zero-delay timers run out. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

export function buttons(app, text) {
  return [...app.walk()].filter((e) => e.tagName === 'BUTTON' && e.textContent === text);
}

export function button(app, text) {
  const all = buttons(app, text);
  if (all.length !== 1) throw new Error(`expected one "${text}" button, found ${all.length}`);
  return all[0];
}
