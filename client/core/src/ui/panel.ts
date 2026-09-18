/**
 * The panel.
 *
 * Rendered into a shadow root: a site's stylesheet must not be able to reach
 * in and make the controls unusable, and our styles must not leak out and
 * break the site. Everything is created with `createElement` -- no
 * `innerHTML` anywhere a room name, a member name or a chat line could reach,
 * because all three are attacker-controlled text from the room's perspective.
 *
 * The root is closed. The page's own scripts, third-party ones included, can
 * otherwise walk into it: read the secret a room creator was handed by the
 * server -- never typed, never in the URL -- and press 참가, 나가기 or 비밀키
 * 교체 for the member. Closed, the page reaches the host element and nothing
 * under it; our own code keeps the handle (`tree`), and the only way to it
 * from outside is the shim's API, which the page cannot see. Only a probe
 * build opens it (`Platform.openPanel`).
 */
import type { MemberInfo } from '../engine/protocol.ts';

const CSS = `
:host { all: initial; }
.panel {
  position: fixed; z-index: 2147483000; right: 16px; bottom: 16px; width: 300px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e9e9ea; background: #17181c; border: 1px solid #303138; border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.45); overflow: hidden;
}
.panel.collapsed .body { display: none; }
.head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: #1f2026; cursor: move; user-select: none;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6d78; flex: none; }
.dot.joined { background: #3ecf6a; }
.dot.connecting { background: #e0b23a; }
.dot.refused, .dot.closed { background: #e05a4f; }
.title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head button { background: none; border: 0; color: #9a9ca6; cursor: pointer; font-size: 14px; padding: 0 2px; }
.body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
label { display: block; font-size: 11px; color: #9a9ca6; margin-bottom: 2px; }
input, button.action {
  width: 100%; box-sizing: border-box; background: #101116; color: #e9e9ea;
  border: 1px solid #303138; border-radius: 6px; padding: 6px 8px; font: inherit;
}
button.action { cursor: pointer; background: #2a5cff; border-color: #2a5cff; color: #fff; font-weight: 600; }
button.action.secondary { background: #23242b; border-color: #303138; color: #c9cbd4; font-weight: 500; }
button.action:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 6px; }
.status { font-size: 12px; color: #9a9ca6; min-height: 1.45em; }
.status.warn { color: #e0b23a; }
.status.err { color: #e05a4f; }
/* Outside .body on purpose: collapsing the panel must not hide it. */
.banner {
  display: none; flex-direction: column; gap: 3px; padding: 8px; margin: 10px 10px 0;
  border: 1px solid #5c4a1c; border-radius: 6px; background: #241f10;
}
.banner.on { display: flex; }
.banner .banner-title { font-weight: 600; color: #e0b23a; }
.banner .banner-body { font-size: 12px; color: #c9cbd4; }
/* Collapsed: the title alone, and it has to carry its own bottom margin. */
.panel.collapsed .banner { margin-bottom: 10px; }
.panel.collapsed .banner .banner-body { display: none; }
.note { font-size: 12px; color: #9a9ca6; }
.note.warn { color: #e0b23a; }
.note.err { color: #e05a4f; }
.members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 96px; overflow-y: auto; }
.members li { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.members .tag { font-size: 10px; color: #9a9ca6; border: 1px solid #303138; border-radius: 4px; padding: 0 4px; }
.chat { display: flex; flex-direction: column; gap: 4px; }
.log { height: 120px; overflow-y: auto; background: #101116; border: 1px solid #303138; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 3px; }
.log .line { font-size: 12px; word-break: break-word; }
.log .who { color: #7f97ff; font-weight: 600; }
.log .sys { color: #9a9ca6; font-style: italic; }
.auth { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid #303138; border-radius: 6px; background: #1b1c21; }
.auth .code { font: 600 16px ui-monospace, monospace; letter-spacing: .1em; text-align: center; padding: 4px; border: 1px dashed #4a4c58; border-radius: 6px; }
.signed { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #9a9ca6; }
.signed span { flex: 1; }
.signed button.action { width: auto; padding: 2px 8px; }
.gesture {
  position: fixed; inset: 0; z-index: 2147483001; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.72); font: 600 18px system-ui, sans-serif; color: #fff; cursor: pointer;
}
.gesture div { padding: 18px 26px; border: 1px solid #4a4c58; border-radius: 12px; background: #17181c; text-align: center; }
.gesture small { display: block; font-weight: 400; font-size: 13px; color: #9a9ca6; margin-top: 6px; }
`;

export type MediaAction = () => void;

export interface UIHandlers {
  onCreateRoom(serverUrl: string, name: string): void;
  onJoin(serverUrl: string, roomId: string, secret: string, name: string): void;
  onLeave(): void;
  onChat(text: string): void;
  onRotate(): void;
  onGesture(): void;
  /**
   * "Sign in in the browser": a login tab on the server's own origin. The
   * one way to sign in from the panel, whatever the method: a key or a
   * password typed here would be typed into the site's page (below).
   */
  onBrowserSignIn?(): void;
  onCancelSignIn?(): void;
  onSignOut?(): void;
}

/** What the sign-in section says. */
export interface SignInOffer {
  /** Methods from the server; empty when it did not say. Every one signs in through the tab. */
  methods: readonly string[];
  notice: string;
}

export interface UIFields {
  serverUrl: string;
  roomId: string;
  secret: string;
  name: string;
}

export class Panel {
  private readonly root: ShadowRoot;
  private readonly host: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly h: UIHandlers;
  private gestureOverlay: HTMLElement | null = null;
  private joined = false;
  private readonly doc: Document;
  private readonly onFullscreen = () => { this.reparent(); };

  constructor(doc: Document, fields: UIFields, handlers: UIHandlers, mode: ShadowRootMode = 'closed') {
    this.doc = doc;
    this.h = handlers;
    this.host = doc.createElement('div');
    this.host.id = 'videosync-root';
    this.root = this.host.attachShadow({ mode });
    const style = doc.createElement('style');
    style.textContent = CSS;
    this.root.append(style, this.build(doc, fields));
    // A site listening on document for its own shortcuts would otherwise act
    // on everything done to the panel: these events are composed and reach the
    // page retargeted to the host, a plain div that no "is the target
    // editable?" or "is this my player?" check skips. Single keys (YouTube's
    // k/j/l, digits, Space) and pointers alike -- a click on our own UI must
    // never toggle playback or fullscreen on the site underneath. Stopped at
    // the root, so every field, button and blank corner is covered, and the
    // name field stays editable while joined.
    //
    // Only propagation past the panel: NOT `preventDefault`, so the panel's own
    // controls keep working, and NOT the capture phase -- `gestures.ts` listens
    // on `window` with `capture: true`, which runs on the way *down*, before
    // this does. It must still see the press, to file it as the member's own
    // but not a press on the player. (A page listening in capture sees them
    // too; that is assumed anyway, see `buildSignIn`.)
    for (const t of [
      'keydown', 'keyup', 'keypress',
      'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu',
    ] as const) {
      this.root.addEventListener(t, (e) => { e.stopPropagation(); });
    }
    doc.documentElement.append(this.host);
    // A fullscreen element is in the top layer: nothing outside it is on
    // screen, so a panel under `documentElement` is invisible for as long as
    // the member watches fullscreen -- which is most of the time, and exactly
    // when the disconnect banner matters. Follow it in and out.
    for (const t of ['fullscreenchange', 'webkitfullscreenchange']) {
      doc.addEventListener(t, this.onFullscreen);
    }
    this.reparent();
  }

  /**
   * Elements that render no children, so putting the host inside one would
   * hide it as surely as leaving it outside. A `<video>` taken fullscreen by
   * itself is the common one; there is nowhere to go then, and the host stays
   * where the site is least likely to trip over it.
   */
  private static readonly NO_CHILDREN = new Set(['VIDEO', 'AUDIO', 'IMG', 'IFRAME', 'CANVAS', 'OBJECT', 'EMBED']);

  /**
   * Put the host inside the current fullscreen element, or back under
   * `documentElement` when there is none.
   *
   * Called on every `fullscreenchange`, and it re-appends whenever the host is
   * not already where it belongs -- a site that reparents or drops our node
   * while rearranging its player is put right by the next change. `append`
   * moves an attached node, so there is nothing to detach first, and the
   * shadow root (and `panelRoot()` with it) is unaffected: it belongs to the
   * host, not to its parent.
   */
  private reparent(): void {
    const d = this.doc as Document & { webkitFullscreenElement?: Element | null };
    const fs = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    const usable = fs && fs !== this.host && !this.host.contains?.(fs) &&
      !Panel.NO_CHILDREN.has(fs.tagName) && typeof (fs as Element & { append?: unknown }).append === 'function';
    const target = usable ? fs : this.doc.documentElement;
    if (this.host.parentNode !== target) target.append(this.host);
  }

  private build(doc: Document, f: UIFields): HTMLElement {
    const mk = <K extends keyof HTMLElementTagNameMap>(
      tag: K, cls?: string, text?: string,
    ): HTMLElementTagNameMap[K] => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };

    const panel = mk('div', 'panel');
    const head = mk('div', 'head');
    const dot = mk('span', 'dot');
    const title = mk('span', 'title', 'VideoSync');
    const collapse = mk('button', '', '–');
    collapse.title = '접기';
    collapse.addEventListener('click', () => panel.classList.toggle('collapsed'));
    head.append(dot, title, collapse);
    this.dragify(head, panel, doc);

    const body = mk('div', 'body');

    const server = mk('input');
    server.placeholder = 'http://localhost:8787';
    server.value = f.serverUrl;
    const name = mk('input');
    name.placeholder = '이름';
    name.value = f.name;
    const room = mk('input');
    room.placeholder = '방 ID';
    room.value = f.roomId;
    const secret = mk('input');
    secret.placeholder = '참가 비밀키';
    secret.value = f.secret;

    const create = mk('button', 'action', '방 만들기');
    create.addEventListener('click', () => this.h.onCreateRoom(server.value.trim(), name.value.trim()));
    const join = mk('button', 'action secondary', '참가');
    join.addEventListener('click', () =>
      this.h.onJoin(server.value.trim(), room.value.trim(), secret.value.trim(), name.value.trim()));
    const leave = mk('button', 'action secondary', '나가기');
    leave.addEventListener('click', () => this.h.onLeave());

    const copy = mk('button', 'action secondary', '초대 링크 복사');
    copy.addEventListener('click', () => {
      const url = new URL(location.href);
      url.hash = `videosync=${encodeURIComponent(room.value)}.${encodeURIComponent(secret.value)}`;
      const link = url.toString();
      const warn = '이 링크를 가진 사람은 누구나 방을 조작할 수 있어요.';
      // No clipboard at all on a page that is not a secure context, and a
      // write can be refused. Either way the user is about to paste whatever
      // was there before, so the link has to be somewhere they can take it.
      const failed = () => this.setStatus(`복사하지 못했어요. 직접 복사하세요: ${link} — ${warn}`, 'warn');
      const clip = navigator.clipboard as Clipboard | undefined;
      if (!clip) { failed(); return; }
      clip.writeText(link).then(() => this.setStatus(`초대 링크를 복사했어요. ${warn}`, 'warn'), failed);
    });
    const rotate = mk('button', 'action secondary', '비밀키 교체');
    rotate.title = '기존 참가자는 그대로 있고, 예전 링크로는 아무도 들어올 수 없게 돼요.';
    rotate.addEventListener('click', () => this.h.onRotate());

    // Nothing the member presses while the session is down reaches the room,
    // and none of it is sent later (engine.ts `onClose`). Nobody would guess
    // that from a coloured dot, so it is said in words -- and it collects
    // nothing, so it is safe in the site's DOM.
    //
    // It is load-bearing, so it has to be seen: it lives outside `.body`, so
    // a collapsed panel still shows it (the title alone), and `reparent` moves
    // the whole host into the fullscreen element, where `documentElement` has
    // nothing on screen.
    //
    // Known hole: a path that goes dark without a close keeps the status at
    // `joined` until the time probe gives up, `SILENT_PROBES` x
    // `timeSyncIntervalMs` -- 15-20 s in which the panel says 연결됨, this
    // banner is off, and a press reaches nobody (engine.ts `timeLoop`).
    const banner = mk('div', 'banner');
    banner.append(
      mk('div', 'banner-title', '연결이 끊겼어요'),
      mk('div', 'banner-body', '지금 누르는 재생·정지·이동은 방에 전해지지 않아요. 다시 연결되면 방 상태로 돌아가요.'),
    );

    const status = mk('div', 'status');
    // Navigating to a different video does not move the room by itself: with no
    // host, an accidental navigation by anybody would drag everyone off what
    // they are watching and nobody could undo it. So it becomes a button.
    const mediaNotice = mk('div', 'status warn');
    const mediaBtn = mk('button', 'action secondary');
    const mediaWrap = mk('div');
    mediaWrap.style.display = 'none';
    mediaWrap.append(mediaNotice, mediaBtn);
    const auth = this.buildSignIn(mk);
    const signed = mk('div', 'signed');
    const signedText = mk('span', '', '서버에 로그인됨');
    const signOut = mk('button', 'action secondary', '로그아웃');
    signOut.addEventListener('click', () => this.h.onSignOut?.());
    signed.append(signedText, signOut);
    signed.style.display = 'none';
    const members = mk('ul', 'members');
    const log = mk('div', 'log');
    const chatInput = mk('input');
    chatInput.placeholder = '메시지…';
    chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
      // The Enter that commits a Hangul syllable arrives mid-composition, with
      // the syllable already in `value`. Sending then clears the box under the
      // IME, which writes the syllable back: a stray last character after
      // every line, and a second message on the next Enter.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter' || !chatInput.value.trim()) return;
      e.stopPropagation(); // site hotkeys must not see what is typed here
      this.h.onChat(chatInput.value);
      chatInput.value = '';
    });

    const field = (labelText: string, input: HTMLElement) => {
      const wrap = mk('div');
      wrap.append(mk('label', '', labelText), input);
      return wrap;
    };
    const row = (...kids: HTMLElement[]) => {
      const r = mk('div', 'row');
      r.append(...kids);
      return r;
    };

    body.append(
      field('서버', server),
      field('이름', name),
      field('방 ID', room),
      field('참가 비밀키', secret),
      row(create, join),
      row(copy, rotate),
      leave,
      status,
      auth,
      signed,
      mediaWrap,
      members,
      log,
      chatInput,
    );
    panel.append(head, banner, body);

    Object.assign(this.el, {
      dot, title, status, banner, members, log, create, join, leave, copy, rotate,
      server, name, room, secret, chatInput, mediaWrap, mediaNotice, mediaBtn,
      signed, signedText,
    });
    this.setJoined(false);
    return panel;
  }

  /**
   * Hidden until a server asks, and then only a button that opens the
   * server's login page in a tab.
   *
   * No key or password field, on purpose. This panel is in the site's DOM, and
   * key events are composed: a capture listener on the page's `window` runs
   * before anything on an input inside a closed shadow root, so the site sees
   * every keystroke typed here, `stopPropagation()` or not. Those secrets mint
   * the device token the privileged side keeps away from this very page
   * (authfetch.ts), and the login tab is on the server's origin, which no site
   * can read.
   */
  private buildSignIn(
    mk: <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => HTMLElementTagNameMap[K],
  ): HTMLElement {
    const wrap = mk('div', 'auth');
    wrap.style.display = 'none';
    // Not `.status`: that class is the panel's one status line.
    const notice = mk('div', 'note warn');
    const browser = mk('button', 'action', '브라우저에서 로그인');
    const code = mk('div', 'code');
    const cancel = mk('button', 'action secondary', '취소');
    browser.addEventListener('click', () => this.h.onBrowserSignIn?.());
    cancel.addEventListener('click', () => this.h.onCancelSignIn?.());
    wrap.append(notice, browser, code, cancel);
    Object.assign(this.el, {
      authWrap: wrap, authNotice: notice, authBrowser: browser, authCode: code, authCancel: cancel,
    });
    return wrap;
  }

  /** Ask to sign in. */
  showSignIn(offer: SignInOffer): void {
    this.showSignInCode(null);
    this.setSignInNotice(offer.notice, 'warn');
    this.el.authWrap!.style.display = '';
  }

  /** The browser login is waiting on its tab; `null` when it is not. */
  showSignInCode(code: string | null): void {
    const c = this.el.authCode!;
    c.textContent = code ?? '';
    c.style.display = code ? '' : 'none';
    this.el.authCancel!.style.display = code !== null ? '' : 'none';
    (this.el.authBrowser as HTMLButtonElement).disabled = code !== null;
  }

  setSignInNotice(text: string, level: '' | 'warn' | 'err' = 'warn'): void {
    this.el.authNotice!.className = `note ${level}`;
    this.el.authNotice!.textContent = text;
  }

  hideSignIn(): void {
    this.showSignInCode(null);
    this.el.authWrap!.style.display = 'none';
  }

  get signInShown(): boolean { return this.el.authWrap!.style.display !== 'none'; }

  /** Whether this page knows the device to be signed in, and as whom. */
  setSignedIn(who: string | null): void {
    this.el.signed!.style.display = who === null ? 'none' : '';
    this.el.signedText!.textContent = who ? `서버에 ${who}(으)로 로그인됨` : '서버에 로그인됨';
  }

  /** Drag by the header. Pointer events so it works with a touch screen too. */
  private dragify(handle: HTMLElement, panel: HTMLElement, doc: Document): void {
    let start: { x: number; y: number; left: number; top: number } | null = null;
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      // A captured pointer's click goes to the capturing element, so capturing
      // a press on a header button would take the click away from it.
      if ((e.target as Element | null)?.closest?.('button')) return;
      const r = panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!start) return;
      panel.style.left = `${start.left + e.clientX - start.x}px`;
      panel.style.top = `${start.top + e.clientY - start.y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    const end = () => { start = null; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    void doc;
  }

  fields(): UIFields {
    return {
      serverUrl: (this.el.server as HTMLInputElement).value.trim(),
      roomId: (this.el.room as HTMLInputElement).value.trim(),
      secret: (this.el.secret as HTMLInputElement).value.trim(),
      name: (this.el.name as HTMLInputElement).value.trim(),
    };
  }

  setFields(f: Partial<UIFields>): void {
    if (f.serverUrl !== undefined) (this.el.server as HTMLInputElement).value = f.serverUrl;
    if (f.roomId !== undefined) (this.el.room as HTMLInputElement).value = f.roomId;
    if (f.secret !== undefined) (this.el.secret as HTMLInputElement).value = f.secret;
    if (f.name !== undefined) (this.el.name as HTMLInputElement).value = f.name;
  }

  setStatus(text: string, level: '' | 'warn' | 'err' = ''): void {
    this.el.status!.className = `status ${level}`;
    this.el.status!.textContent = text;
  }

  setConnection(state: string): void {
    this.el.dot!.className = `dot ${state}`;
  }

  /**
   * The disconnect banner: on while a session that had joined is not joined.
   *
   * It is not decoration. Nothing the member does to the player while the
   * session is down is sent to the room -- not then, not on reconnect -- so
   * without this the panel shows a dot and the member goes on pressing
   * buttons that do nothing. See `engine.ts` `onClose`.
   */
  setDisconnected(on: boolean): void {
    this.el.banner!.className = on ? 'banner on' : 'banner';
  }

  /**
   * `inSession`: there is a session to leave, joined or not. One that is
   * reconnecting, or waiting for a sign-in, keeps running until left, and
   * would otherwise take the member back into the room they meant to leave.
   */
  setJoined(joined: boolean, inSession = joined): void {
    this.joined = joined;
    for (const k of ['create', 'join'] as const) (this.el[k] as HTMLButtonElement).disabled = joined;
    (this.el.leave as HTMLButtonElement).disabled = !inSession;
    for (const k of ['copy', 'rotate'] as const) (this.el[k] as HTMLButtonElement).disabled = !joined;
    (this.el.chatInput as HTMLInputElement).disabled = !joined;
  }

  setMembers(ms: readonly MemberInfo[], selfId: string, waitingOn: readonly string[]): void {
    const ul = this.el.members!;
    ul.textContent = '';
    const doc = ul.ownerDocument;
    for (const m of ms) {
      const li = doc.createElement('li');
      const nameEl = doc.createElement('span');
      nameEl.textContent = m.name || m.id;           // never innerHTML: this is someone else's text
      li.append(nameEl);
      const tag = (t: string) => {
        const s = doc.createElement('span');
        s.className = 'tag';
        s.textContent = t;
        li.append(s);
      };
      if (m.id === selfId) tag('나');
      if (m.suspended) tag('자리비움');
      if (waitingOn.includes(m.id)) tag('버퍼링');
      ul.append(li);
    }
  }

  addChat(who: string, text: string, system = false): void {
    const log = this.el.log!;
    const doc = log.ownerDocument;
    const line = doc.createElement('div');
    line.className = 'line';
    if (system) {
      line.classList.add('sys');
      line.textContent = text;
    } else {
      const w = doc.createElement('span');
      w.className = 'who';
      w.textContent = `${who}: `;
      const t = doc.createElement('span');
      t.textContent = text;
      line.append(w, t);
    }
    log.append(line);
    while (log.childElementCount > 200) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  /**
   * Offer to move the room to what this member is watching. With no action,
   * only the notice: a button that can do nothing must not be shown.
   */
  setMediaAction(notice: string, label?: string, action?: MediaAction): void {
    this.el.mediaNotice!.textContent = notice;
    const btn = this.el.mediaBtn as HTMLButtonElement;
    btn.textContent = label ?? '';
    btn.onclick = action ?? null;
    btn.style.display = action ? '' : 'none';
    this.el.mediaWrap!.style.display = '';
  }

  clearMediaAction(): void {
    this.el.mediaWrap!.style.display = 'none';
    (this.el.mediaBtn as HTMLButtonElement).onclick = null;
  }

  /**
   * The gesture-capture overlay. `play()` was refused and nothing exposes the
   * Media Engagement Index, so the only way back is a real user click -- and it
   * has to be a click on something of ours, because a click on the site's own
   * play button would fight the room.
   */
  showGesturePrompt(doc: Document): void {
    if (this.gestureOverlay) return;
    const o = doc.createElement('div');
    o.className = 'gesture';
    const box = doc.createElement('div');
    box.textContent = '클릭해서 동기화';
    const small = doc.createElement('small');
    small.textContent = '브라우저가 자동 재생을 막았어요. 한 번 눌러주면 방에 맞춰 재생돼요.';
    box.append(small);
    o.append(box);
    o.addEventListener('click', () => { this.hideGesturePrompt(); this.h.onGesture(); });
    this.root.append(o);
    this.gestureOverlay = o;
  }

  hideGesturePrompt(): void {
    this.gestureOverlay?.remove();
    this.gestureOverlay = null;
  }

  get isJoined(): boolean { return this.joined; }

  /** The closed root, for the shim's own API (the browser probes drive it). */
  get tree(): ShadowRoot { return this.root; }

  /** The element the panel lives in: input inside it is not a press on the player. */
  get hostElement(): HTMLElement { return this.host; }

  destroy(): void {
    for (const t of ['fullscreenchange', 'webkitfullscreenchange']) {
      this.doc.removeEventListener(t, this.onFullscreen);
    }
    this.host.remove();
  }
}
