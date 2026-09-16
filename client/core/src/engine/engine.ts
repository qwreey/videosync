/**
 * The sync engine: adapter + detector + clock + protocol, and nothing that
 * knows about a browser.
 *
 * Everything time-shaped is injected (`now`, `setTimer`, `clearTimer`,
 * `transport`, `isHidden`) so the engine runs unchanged in a browser, in a
 * userscript, and in a Node test against a real `videosyncd`.
 */
import type { PlayerState, ProviderAdapter } from '../adapter/types.ts';
import { AutoplayBlockedError } from '../adapter/types.ts';
import { SeekDetector } from '../detector/detector.ts';
import type { DetectorConfig } from '../detector/types.ts';
import { type Anchor, expectedAt, ServerClock } from './clock.ts';
import type {
  ClientFrame, CmdKind, HbFrame, MemberInfo, ServerFrame,
} from './protocol.ts';
import type { Transport } from './transport.ts';

export interface EngineConfig {
  room: string;
  secret: string;
  name: string;
  /** Normalized provider+content identity. NOT the raw URL. */
  mediaKey: string;
  /** Where `mediaKey` can be opened (`watchUrl`), for a room this member names. */
  mediaUrl?: string;

  evalIntervalMs: number;
  hbIntervalMs: number;
  timeSyncIntervalMs: number;
  /** Rapid probes on connect, so the offset settles before anything moves. */
  connectProbes: number;
  connectProbeSpacingMs: number;
  /**
   * Floor between two anomaly reports. The server's heartbeat bucket allows a
   * burst of 40 then 20/s and drops the excess *silently* -- a report is
   * advisory, so answering a flood would only add traffic. An engine that
   * reported on every 100 ms evaluation would be throttled without ever being
   * told, and would look like it was working.
   */
  minReportIntervalMs: number;
  reportThresholdMs: number;
  /** Do not seek to satisfy a transition we are already this close to. */
  seekToleranceMs: number;
  /**
   * How long the player may disagree with the anchor about play state before
   * the engine re-applies it.
   *
   * The anchor is truth, and until now nothing enforced that for the PAUSE
   * state: a `play()` that failed, a transition that lost a race, a site that
   * paused the element for its own reasons -- each left the member paused
   * against a playing room, reporting a growing residual, being seek-corrected
   * forever, because the corrector only ever seeks or nudges and never presses
   * play. Long enough that a genuine local pause has time to become a command
   * and come back as a new anchor.
   */
  reconcileAfterMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  rateMin: number;
  rateMax: number;
  /**
   * Seed the room from this member's own player, once, on the first settled
   * evaluation after joining. Set only by whoever CREATED the room.
   *
   * A room is created with the anchor at `paused@0` (`hub.Create`), and the
   * detector only reports play-state *transitions* -- so a creator whose video
   * was already playing never announces itself: `cmdsSent` stays 0 and the
   * room defends a position nobody is at. The player is dragged back to 0
   * every `reconcileAfterMs` while the servo nudges it, forever. Measured in
   * the field on Laftel, alone in a room.
   *
   * It sends ordinary commands rather than mutating the room from `hello`,
   * because a room only changes by a command that takes a `seq` and reaches
   * everyone (SYNTHESIS 5). A joiner never sets this: the anchor is truth and
   * a joiner must conform to it.
   */
  adoptLocalStateOnJoin: boolean;
  /**
   * When this member starts playback locally in a room of two or more, stop
   * again at once and start at `when` with everybody else.
   *
   * `play` carries the full command lead, and everyone must start moving at
   * the same instant from the same position. Left playing, the presser was
   * the one who gave: measured live on Laftel, their picture jumped back
   * ~650 ms when the transition landed, they rewatched ~725 ms, and the
   * seek-back left them ~165 ms behind the member who merely pressed play on
   * a paused element (BROWSER-FINDINGS §15). Holding costs the lead as a
   * short wait before the picture moves, and nothing else.
   *
   * Not in a room of one: that room schedules nothing (`CmdDelay()` is 0),
   * so there is nothing to wait for and the hold would only flicker.
   */
  holdLocalPlay: boolean;
  detector: Partial<DetectorConfig>;
}

export const DEFAULT_ENGINE_CONFIG: Omit<EngineConfig, 'room' | 'secret' | 'name' | 'mediaKey'> = {
  evalIntervalMs: 100,
  hbIntervalMs: 1000,
  timeSyncIntervalMs: 5000,
  connectProbes: 5,
  connectProbeSpacingMs: 50,
  minReportIntervalMs: 250,
  reportThresholdMs: 250,
  seekToleranceMs: 250,
  reconcileAfterMs: 3000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 15000,
  rateMin: 0.95,
  rateMax: 1.1,
  adoptLocalStateOnJoin: false,
  holdLocalPlay: true,
  detector: {},
};

export type EngineStatus =
  | 'idle' | 'connecting' | 'joining' | 'joined' | 'refused' | 'closed';

export interface ChatLine {
  from: string; name: string; text: string; serverMs: number;
}

export interface EngineEvents {
  onStatus?(s: EngineStatus, detail?: string): void;
  onMembers?(m: readonly MemberInfo[]): void;
  onChat?(line: ChatLine): void;
  /** `waiting` = a command is held. `waitingOn` non-empty without it = "show a spinner". */
  onGate?(waiting: boolean, waitingOn: readonly string[]): void;
  onSecretRotated?(secret: string, by: string): void;
  onMediaMismatch?(roomMediaKey: string, yours: string): void;
  onError?(code: string, msg: string): void;
  /**
   * The browser refused playback for lack of a user gesture. The UI must offer
   * a click; `resumeAfterGesture()` retries. Until then this member cannot
   * follow the room no matter what the server does.
   */
  onAutoplayBlocked?(): void;
  onAnchor?(a: Anchor): void;
}

export interface EngineDeps {
  adapter: ProviderAdapter;
  transport: Transport;
  /** Monotonic milliseconds. Used for the clock estimate AND for scheduling. */
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(h: number): void;
  isHidden(): boolean;
}

interface Scheduled {
  seq: number;
  whenServerMs: number;
  /** When the server emitted it. Equal to `when` for a command applied with no
   *  lead, which is how a genuinely late apply stays distinguishable from one
   *  that was never scheduled ahead at all. */
  emittedAtServerMs: number;
  anchor: Anchor;
  kind: string;
}

/** Counters, for tests and for a diagnostics panel. */
export interface EngineStats {
  cmdsSent: number;
  statesApplied: number;
  acksApplied: number;
  correctionsSeek: number;
  correctionsNudge: number;
  nudgesUnsupported: number;
  reportsSent: number;
  timeSamples: number;
  reconnects: number;
  lateApplies: number;
  echoesSuppressed: number;
  /** Frames the server refused as malformed. Any value above zero is our bug. */
  badFrames: number;
  /** Transitions not applied because this member is watching something else. */
  skippedOffMedia: number;
  /** Queued transitions dropped because a newer one took over, or the session ended. */
  supersededApplies: number;
  /** The transport refused to open at all. Any value above zero is our bug or a dead extension context. */
  connectFailures: number;
  /** play() failed for a reason that is not an autoplay refusal. */
  playFailures: number;
  /** Local plays re-paused to wait for the room's `when` (`holdLocalPlay`). */
  playsHeld: number;
  /** Reports held back because the player looked unready mid-seek. */
  reportsDeferred: number;
  /** Times the player disagreed with the anchor long enough to be re-applied. */
  reconciles: number;
}

/**
 * One line of the wire trace.
 *
 * Kept deliberately small and always on. Every bug this design has produced in
 * the field was one-shot -- a room that fought its creator, a pause that jumped
 * -- and a trace you have to switch on first would have missed all of them. The
 * cost of always recording is a bounded array of small objects.
 */
export interface TraceEntry {
  /** Client-monotonic ms, the same clock `now()` returns. */
  at: number;
  dir: 'tx' | 'rx';
  t: string;
  /** Whatever of `seq`/`when`/`kind`/`positionMs`/`mode` the frame carried. */
  detail: Record<string, unknown>;
}

const TRACE_MAX = 250;

/**
 * How far off the anchor a held player may be left before it is re-aimed.
 *
 * Not zero, and not a rounding allowance either: a seek is not free even in
 * the buffer. Measured on Laftel, an element seeked while paused starts ~70 ms
 * late when it resumes (61-79 ms, against +9-22 ms for one that was merely
 * paused), so re-aiming anything smaller than that makes the start worse
 * rather than better (BROWSER-FINDINGS §16).
 */
const HOLD_SEEK_TOLERANCE_MS = 80;

/**
 * A report that says "not ready" while plenty is buffered ahead is, almost
 * always, a report taken in the middle of an in-buffer seek: on Laftel
 * `readyState` sits at 1 for ~100 ms of every one, with 45 s buffered
 * (BROWSER-FINDINGS §14). Sent, it gates the room for nothing until the next
 * report, and a play pressed in that window waits for it. Such a report is
 * held back for at most this long -- long enough for a seek, short enough that
 * a player genuinely stuck with a full buffer is still reported as stuck.
 * Deferring, not rewriting: whatever is sent is what the player said.
 */
const TRANSIENT_UNREADY_MS = 300;
/** Buffered ahead above which "not ready" is taken to be transient. */
const TRANSIENT_UNREADY_MIN_AHEAD_S = 1;

export class SyncEngine {
  readonly cfg: EngineConfig;
  readonly clock = new ServerClock();
  readonly detector: SeekDetector;
  readonly stats: EngineStats = {
    cmdsSent: 0, statesApplied: 0, acksApplied: 0, correctionsSeek: 0,
    correctionsNudge: 0, nudgesUnsupported: 0, reportsSent: 0, timeSamples: 0,
    reconnects: 0, lateApplies: 0, echoesSuppressed: 0, badFrames: 0,
    skippedOffMedia: 0, supersededApplies: 0, connectFailures: 0,
    playFailures: 0, playsHeld: 0, reportsDeferred: 0, reconciles: 0,
  };

  private readonly d: EngineDeps;
  private readonly ev: EngineEvents;

  private status: EngineStatus = 'idle';
  private selfId = '';
  private members: readonly MemberInfo[] = [];
  private anchor: Anchor = { positionMs: 0, atServerMs: 0, paused: true, mediaKey: '' };
  private lastAppliedSeq = 0;
  /**
   * What THIS member is watching right now, which is not always what the room
   * is watching. Kept separate from `cfg.mediaKey` because a single-page router
   * can change it mid-session without a reload.
   */
  private localMediaKey: string;
  private localMediaUrl: string;

  private pending: Scheduled[] = [];
  private applyTimer = 0;
  private evalTimer = 0;
  private timeTimer = 0;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;

  private lastHbAt = 0;
  private lastReportAt = 0;
  private reqSeq = 0;
  private running = false;

  /**
   * Backstop only. Echo suppression is structural -- the two-diff test for
   * seeks, `rebaseline(pos, paused)` for play/pause. This flag exists solely
   * for the window in which an async seek is in flight, and nothing may be
   * load-bearing on it: syncwatch ships a load-bearing ignore-flag and it
   * deadlocks silently and forever (`content.ts:87-104`).
   */
  private applyingRemote = false;
  /**
   * The current room secret: the one joined with, until the room rotates it.
   * Every reconnect's `hello` is checked against the server's CURRENT secret.
   */
  private secret: string;

  /** True once `play()` was refused for lack of a user gesture. */
  private autoplayBlocked = false;
  /** Unsubscribes the adapter listener, so a stopped engine stops listening. */
  private unsubscribeAdapter: (() => void) | null = null;
  /** When the player first started disagreeing with the anchor about play state. */
  private disagreeingSince = 0;
  /** The last playbackRate this engine set, or 1 if it has not set one. */
  private rateWeSet = 1;
  /** When the player started looking unready with a full buffer, or 0. */
  private transientUnreadySince = 0;
  /** One-shot: the creator's seed, consumed by the first settled evaluation. */
  private pendingAdopt = false;

  /** The last TRACE_MAX frames in either direction. See `TraceEntry`. */
  private readonly traceRing: TraceEntry[] = [];

  /**
   * Every mutation of the player runs through here, one at a time.
   *
   * There are four un-serialised ways into the player -- a scheduled
   * transition, a correction, an element swap, and a gesture retry -- and each
   * of them awaits a seek that can take hundreds of milliseconds. Overlapping
   * them inverts their effects: a `pause` parked inside `seekTo` finishes AFTER
   * the `play` that superseded it, leaving the player paused with an anchor
   * that says playing. Nothing recovers from that -- the corrector only ever
   * seeks or nudges, it never presses play -- so the member sits paused against
   * a playing room, being seek-corrected forever.
   */
  private applyChain: Promise<void> = Promise.resolve();
  private draining = false;
  /**
   * Bumped whenever the session ends -- a disconnect, or `stop()`.
   *
   * A queued player mutation can be parked inside a seek for up to ten seconds.
   * Without this it resumes into a session that no longer exists: it acts on a
   * stale anchor with a clock that was just reset, or -- after `stop()` -- it
   * starts the video playing seconds after the user left the room.
   */
  private epoch = 0;

  /**
   * The one place a frame leaves this engine, so the trace cannot miss one.
   *
   * It lives here rather than in the transport because the two shims have
   * different transports -- the extension relays through its service worker --
   * and `dump()` has to mean the same thing in both.
   */
  private tx(f: ClientFrame): void {
    this.record('tx', f.t, f as unknown as Record<string, unknown>);
    this.d.transport.send(f);
  }

  private record(dir: 'tx' | 'rx', t: string, f: Record<string, unknown>): void {
    const detail: Record<string, unknown> = {};
    for (const k of ['seq', 'when', 'kind', 'positionMs', 'mode', 'rate', 'code', 'reqId', 'mediaKey', 'mediaUrl'] as const) {
      if (f[k] !== undefined) detail[k] = f[k];
    }
    // The anchor is the thing you actually want when reading a trace back.
    const a = f['anchor'] as Anchor | undefined;
    if (a) detail['anchor'] = `${a.positionMs}${a.paused ? 'P' : '-'}@${a.atServerMs}`;
    this.traceRing.push({ at: Math.round(this.d.now()), dir, t, detail });
    if (this.traceRing.length > TRACE_MAX) this.traceRing.shift();
  }

  private serialise(fn: () => Promise<void>): Promise<void> {
    const next = this.applyChain.then(fn).catch(() => { /* one failure must not wedge the chain */ });
    this.applyChain = next;
    return next;
  }

  constructor(deps: EngineDeps, cfg: EngineConfig, events: EngineEvents = {}) {
    this.d = deps;
    this.cfg = cfg;
    this.ev = events;
    this.localMediaKey = cfg.mediaKey;
    this.localMediaUrl = cfg.mediaUrl ?? '';
    this.secret = cfg.secret;
    this.pendingAdopt = cfg.adoptLocalStateOnJoin;
    this.detector = new SeekDetector(deps.isHidden, {
      ...cfg.detector,
      evalIntervalMs: cfg.evalIntervalMs,
      reportThresholdMs: cfg.reportThresholdMs,
    });
    // A single-page router replaces the element, and the new one starts at 0.
    // Without this the next evaluation sees a 300 s backward jump that is large
    // in BOTH diffs, calls it a user seek, and drags the whole room to the
    // start of a video nobody else is watching.
    // docs/PROTOCOL.md section 4: "DOM events TRIGGER this evaluation, they never
    // broadcast directly. One decision path, two input sources." The second
    // source was wired up in the adapter and subscribed by nobody, so the 100 ms
    // poll was the only input and a user's seek could sit undetected for a
    // whole interval. Everything an event does is run the same evaluation the
    // timer runs; nothing about the decision changes.
    const unsubs = (['seeked', 'play', 'pause', 'ratechange', 'waiting', 'playing'] as const)
      .map((ev) => deps.adapter.on(ev, () => { if (this.running) this.evaluate(); }));
    const unsubReplaced = deps.adapter.on('elementreplaced', () => {
      this.detector.reset();
      // If we are still on the room's media, put the new element where the
      // room is. If we are not, leave it alone -- snapping someone's next
      // episode to the old one's timestamp is worse than doing nothing.
      if (this.status === 'joined' && this.onRoomMedia()) {
        void this.serialise(() =>
          this.applyTransition(expectedAt(this.anchor, this.serverNow()), this.anchor.paused));
      }
    });
    this.unsubscribeAdapter = () => {
      for (const u of unsubs) u();
      unsubReplaced();
    };
  }

  /**
   * Tell the engine what this member is now watching. The room does not follow
   * -- that takes a `media` command, which somebody has to choose.
   */
  setLocalMediaKey(key: string, url = ''): void {
    this.localMediaUrl = url;
    if (key === this.localMediaKey) return;
    this.localMediaKey = key;
    this.detector.reset();
  }

  /**
   * Whether we are watching what the room is watching.
   *
   * A member on different media cannot follow the room and must not steer it:
   * their position is measured against a different timeline, so every command
   * they send and every residual they report is meaningless to everyone else.
   * Empty on either side means "not established yet", which is not a
   * disagreement.
   */
  private onRoomMedia(): boolean {
    if (!this.localMediaKey || !this.anchor.mediaKey) return true;
    return this.localMediaKey === this.anchor.mediaKey;
  }

  // --- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.evalTimer = this.d.setTimer(() => this.evalLoop(), this.cfg.evalIntervalMs);
  }

  stop(): void {
    this.running = false;
    this.releaseRate();
    this.epoch++;
    this.unsubscribeAdapter?.();
    this.unsubscribeAdapter = null;
    this.d.clearTimer(this.evalTimer); this.evalTimer = 0;
    this.d.clearTimer(this.timeTimer); this.timeTimer = 0;
    this.d.clearTimer(this.applyTimer); this.applyTimer = 0;
    this.d.clearTimer(this.reconnectTimer); this.reconnectTimer = 0;
    this.pending = [];
    this.d.transport.close();
    this.setStatus('closed');
  }

  private connect(): void {
    this.setStatus('connecting');
    try {
      this.d.transport.connect({
        onOpen: () => this.onOpen(),
        onFrame: (f) => this.onFrame(f),
        onClose: (clean, reason) => this.onClose(clean, reason),
      });
    } catch (e) {
      // `chrome.runtime.connect()` throws synchronously once the extension has
      // been reloaded or auto-updated under a tab that stayed open. Unguarded,
      // that throw escapes a timer callback, no further reconnect is ever
      // armed, and the panel sits on "connecting" forever with nothing
      // anywhere recording a failure -- the one way this design could end a
      // session rather than degrade it.
      this.stats.connectFailures++;
      this.ev.onError?.('transport', (e as Error).message);
      this.onClose(false, `transport: ${(e as Error).message}`);
    }
  }

  private onOpen(): void {
    this.reconnectAttempt = 0;
    this.setStatus('joining');
    this.tx({
      // Not `cfg.secret`: after a rotation the server accepts only the new one,
      // and a refused reconnect ends the session for good.
      t: 'hello', room: this.cfg.room, secret: this.secret,
      name: this.cfg.name,
      // The CURRENT media, not the one we joined with: a reconnect after a
      // navigation would otherwise announce the wrong thing.
      mediaKey: this.localMediaKey,
      ...(this.localMediaUrl ? { mediaUrl: this.localMediaUrl } : {}),
    });
    // Rapid probes first: nothing may be scheduled against an unsettled offset.
    for (let i = 0; i < this.cfg.connectProbes; i++) {
      this.d.setTimer(() => this.probeTime(), i * this.cfg.connectProbeSpacingMs);
    }
    this.d.clearTimer(this.timeTimer);
    this.timeTimer = this.d.setTimer(() => this.timeLoop(), this.cfg.timeSyncIntervalMs);
  }

  private onClose(clean: boolean, reason: string): void {
    this.d.clearTimer(this.timeTimer); this.timeTimer = 0;
    this.d.clearTimer(this.applyTimer); this.applyTimer = 0;
    this.pending = [];
    if (!this.running || clean || this.status === 'refused') {
      this.setStatus('closed', reason);
      return;
    }
    // The offset was measured against a socket, and possibly a route, that no
    // longer exists. Keeping it would let a stale bias survive the one event
    // that could have cleared it.
    this.clock.reset();
    this.detector.reset();
    // NOT zeroed: `welcome` sets it from the server, and zeroing it here
    // disarmed the supersede guard for any mutation still queued from the old
    // session (`p.seq < lastAppliedSeq` can never be true against 0). The
    // epoch is what invalidates that work now.
    this.epoch++;
    this.stats.reconnects++;
    const backoff = Math.min(
      this.cfg.reconnectMaxMs,
      this.cfg.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt++;
    this.setStatus('connecting', `reconnecting in ${backoff}ms: ${reason}`);
    this.reconnectTimer = this.d.setTimer(() => {
      if (this.running) this.connect();
    }, backoff);
  }

  private setStatus(s: EngineStatus, detail?: string): void {
    this.status = s;
    this.ev.onStatus?.(s, detail);
  }

  // --- clock ----------------------------------------------------------------

  private probeTime(): void {
    if (!this.running) return;
    // Rounded, and this is not cosmetic: every millisecond field on the wire is
    // an int64 on the server, and `performance.now()` is fractional. Sending
    // `t0: 874.47` made the server reject every clock probe with `bad_frame` --
    // the session stayed joined, the clock never settled, and therefore no
    // correction ever fired. Found by the end-to-end test; nothing that mocks
    // one side of the wire could have found it.
    this.tx({ t: 'time', t0: Math.round(this.d.now()) });
  }

  private timeLoop(): void {
    this.probeTime();
    this.timeTimer = this.d.setTimer(() => this.timeLoop(), this.cfg.timeSyncIntervalMs);
  }

  private serverNow(): number { return this.clock.serverNow(this.d.now()); }

  // --- inbound --------------------------------------------------------------

  private onFrame(f: ServerFrame): void {
    this.record('rx', f.t, f as unknown as Record<string, unknown>);
    switch (f.t) {
      case 'welcome':
        this.selfId = f.you;
        this.members = f.members;
        this.anchor = f.anchor;
        this.lastAppliedSeq = f.seq;
        this.setStatus('joined');
        this.ev.onMembers?.(f.members);
        this.ev.onAnchor?.(f.anchor);
        // Do NOT snap the player here: the offset has not settled yet, so
        // expected() is not yet meaningful. The first heartbeat's residual
        // brings us in, judged by a server that knows our uncertainty.
        break;

      case 'time.reply':
        // A pending transition's timer was converted through the old offset.
        if (this.clock.addSample({ t0: f.t0, tRecv: f.tRecv, tSend: f.tSend, t1: this.d.now() })) {
          this.rearm();
        }
        this.stats.timeSamples++;
        break;

      case 'state':
        this.schedule({
          seq: f.seq, whenServerMs: f.when, emittedAtServerMs: f.emittedAt,
          anchor: f.anchor, kind: f.kind,
        });
        this.stats.statesApplied++;
        break;

      case 'ack':
        // The originator's copy takes the SAME path. Excluding the sender from
        // the broadcast for echo suppression must not exclude it from the
        // simultaneity the timebase exists to provide.
        this.schedule({
          seq: f.seq, whenServerMs: f.when, emittedAtServerMs: f.emittedAt,
          anchor: f.anchor, kind: f.kind,
        });
        this.stats.acksApplied++;
        break;

      case 'correct':
        void this.applyCorrection(f.mode, f.rate);
        break;

      case 'gate':
        // UI only. The gate holds the COMMAND on the server, before the anchor
        // moves; it needs no cooperation here and must never pause the player.
        this.ev.onGate?.(f.waiting, f.waitingOn ?? []);
        break;

      case 'members':
        this.members = f.members;
        this.ev.onMembers?.(f.members);
        break;

      case 'chat':
        this.ev.onChat?.({ from: f.from, name: f.name, text: f.text, serverMs: f.serverMs });
        break;

      case 'secret':
        this.secret = f.secret;
        this.ev.onSecretRotated?.(f.secret, f.rotated);
        break;

      case 'media.mismatch':
        this.ev.onMediaMismatch?.(f.roomMediaKey, f.yours);
        break;

      case 'error':
        if (f.code === 'join_refused' || f.code === 'room_full') this.setStatus('refused', f.code);
        // A `bad_frame` is never the server's fault -- it means WE sent
        // something malformed, and the symptom is a mechanism quietly not
        // working rather than anything failing. Counted so a test can assert
        // on zero.
        if (f.code === 'bad_frame' || f.code === 'bad_kind' || f.code === 'bad_cmd') {
          this.stats.badFrames++;
        }
        this.ev.onError?.(f.code, f.msg ?? '');
        break;

      default:
        // A frame type we do not know is not an error: the server may be newer
        // than we are, and dropping the session over it would make every
        // deploy a breaking change.
        break;
    }
  }

  // --- scheduled transitions ------------------------------------------------

  private schedule(s: Scheduled): void {
    if (s.seq <= this.lastAppliedSeq) return; // stale (docs/PROTOCOL.md §3)
    this.pending = this.pending.filter((p) => p.seq !== s.seq);
    this.pending.push(s);
    this.pending.sort((a, b) => a.whenServerMs - b.whenServerMs);
    this.rearm();
  }

  private rearm(): void {
    this.d.clearTimer(this.applyTimer);
    this.applyTimer = 0;
    const next = this.pending[0];
    if (!next) return;
    if (!this.clock.ready) {
      // With no offset yet, `clientTime` is a Unix epoch minus a page-relative
      // number -- about 1.8e12 ms, which setTimeout's long conversion turns
      // into a timer roughly seventeen days out. The transition would never
      // fire at its `when`; it recovered only because the server's stale-anchor
      // resend eventually replaced it, a second late and unsynchronised. Wait
      // for the clock instead, and re-check at the evaluation rate.
      this.applyTimer = this.d.setTimer(() => { void this.drain(); }, this.cfg.evalIntervalMs);
      return;
    }
    const delay = Math.max(0, this.clock.clientTime(next.whenServerMs) - this.d.now());
    this.applyTimer = this.d.setTimer(() => { void this.drain(); }, delay);
  }

  private async drain(): Promise<void> {
    this.applyTimer = 0;
    if (this.draining) return; // a frame arriving mid-apply re-arms the timer
    if (!this.clock.ready) { this.rearm(); return; } // nothing can be scheduled yet
    this.draining = true;
    try {
      const serverNow = this.serverNow();
      while (this.pending.length > 0 && this.pending[0]!.whenServerMs <= serverNow) {
        const p = this.pending.shift()!;
        await this.applyScheduled(p);
      }
    } finally {
      this.draining = false;
      this.rearm();
    }
  }

  private applyScheduled(p: Scheduled): Promise<void> {
    if (p.seq <= this.lastAppliedSeq) return Promise.resolve();
    // Bookkeeping is synchronous even though the player work is queued, so a
    // command that arrives while an earlier one is still touching the player
    // knows it has been superseded.
    this.lastAppliedSeq = p.seq;
    this.anchor = p.anchor;
    this.ev.onAnchor?.(p.anchor);

    // Track the room's state, but do not move a player that is showing
    // different media: the room's position means nothing on our timeline.
    if (!this.onRoomMedia()) {
      this.stats.skippedOffMedia++;
      return Promise.resolve();
    }

    const epoch = this.epoch;
    return this.serialise(async () => {
      if (epoch !== this.epoch) {
        // The session ended while this was queued -- a reconnect, or the user
        // left. Acting now would move a player nobody is watching with us.
        this.stats.supersededApplies++;
        return;
      }
      if (p.seq < this.lastAppliedSeq) {
        // Something newer took over while we were queued. Applying this now
        // would move the player backwards into a state the room has left.
        this.stats.supersededApplies++;
        return;
      }
      // If `when` has already passed -- the normal case on a slow link -- the
      // room has moved on since. Aim at where it is NOW, never at where it was
      // when the command was emitted. Computed inside the queue, because time
      // passes while waiting for it. (The server-side twin of this bug made
      // every correction land one downlink delay behind.)
      const serverNow = this.serverNow();
      // Only a command that WAS scheduled ahead can be applied late. One that
      // leaves the room stopped carries `when == emittedAt` by design, and
      // counting those would make this diagnostic read "every pause is late".
      if (p.whenServerMs > p.emittedAtServerMs &&
        serverNow > p.whenServerMs + this.cfg.seekToleranceMs) {
        this.stats.lateApplies++;
      }
      const targetMs = expectedAt(p.anchor, Math.max(serverNow, p.anchor.atServerMs));
      await this.applyTransition(targetMs, p.anchor.paused);
    });
  }

  private async applyTransition(
    targetMs: number, paused: boolean, toleranceMs = this.cfg.seekToleranceMs,
  ): Promise<void> {
    const a = this.d.adapter;
    this.applyingRemote = true;
    try {
      const cur = a.readState().positionS * 1000;
      if (Math.abs(cur - targetMs) > toleranceMs && a.capabilities.supportsDirectSeek) {
        await a.seekTo(targetMs / 1000).catch(() => { /* a stalled seek is reported, not thrown */ });
      }
      if (paused) {
        await a.pause();
      } else {
        await this.tryPlay();
      }
    } finally {
      this.applyingRemote = false;
      const s = a.readState();
      // Rebaseline with what the player ACTUALLY did, including its pause
      // state -- that is what keeps our own transition from coming back around
      // as user intent.
      this.detector.rebaseline(s.positionS, s.paused);
    }
  }

  private async tryPlay(): Promise<void> {
    try {
      await this.d.adapter.play();
      this.autoplayBlocked = false;
    } catch (e) {
      if (e instanceof AutoplayBlockedError) {
        // Swallowing this leaves us paused while the room plays, reporting a
        // residual that grows forever, and the server seeking us over and over
        // -- every seek "working" and the residual never closing.
        this.autoplayBlocked = true;
        this.ev.onAutoplayBlocked?.();
        return;
      }
      // Everything else -- most commonly AbortError, "the play() request was
      // interrupted", which is routine when a site's own logic reacts to our
      // seek. Rethrowing propagated out of the queued closure into
      // `serialise`'s catch and vanished, leaving the member paused against a
      // playing room with no counter and nothing that would ever press play
      // again. Counted, and left for the reconciler below to fix.
      this.stats.playFailures++;
      this.ev.onError?.('play_failed', (e as Error).message);
    }
  }

  /**
   * Retry a refused play from inside a user gesture.
   *
   * If the room is paused right now there is nothing to play, and the earlier
   * refusal is no longer a fact about anything -- so the flag is cleared
   * outright. Leaving it set made the click do nothing at all: a blocked member
   * sends no commands and reports `suspended`, so they could not press play,
   * could not be corrected, and could not be gated on. The room sat paused
   * waiting for somebody, and that somebody's clicks were being swallowed with
   * no symptom anywhere.
   */
  async resumeAfterGesture(): Promise<void> {
    if (!this.autoplayBlocked) return;
    if (this.anchor.paused) {
      this.autoplayBlocked = false;
      return;
    }
    await this.serialise(() =>
      this.applyTransition(expectedAt(this.anchor, this.serverNow()), this.anchor.paused));
  }

  private async applyCorrection(mode: 'seek' | 'nudge', rate?: number): Promise<void> {
    const a = this.d.adapter;
    // The same two guards a scheduled transition gets. Without the media one, a
    // correction already in flight when the user navigates seeks episode two's
    // player to episode one's position; without the clock one, `expected()`
    // with a zero offset asks for a position around -1.8e12 ms, which clamps to
    // the start of the video and then blocks the queue for the seek's full
    // ten-second timeout.
    if (!this.onRoomMedia()) return;
    if (mode === 'seek' && !this.clock.ready) return;
    if (mode === 'nudge') {
      if (!a.capabilities.supportsPlaybackRateNudge) {
        // A provider that fights playbackRate gets seek-only correction. Count
        // it: silently ignoring the whole frequency half of the control law
        // would look like the servo simply performing badly.
        this.stats.nudgesUnsupported++;
        return;
      }
      const r = Math.min(this.cfg.rateMax, Math.max(this.cfg.rateMin, rate ?? 1));
      a.setRate(r);
      this.rateWeSet = r;
      this.stats.correctionsNudge++;
      return;
    }
    // Re-derive the target here, at apply time, from our own anchor and clock.
    // The frame deliberately carries no position: one computed at send time is
    // stale by a downlink delay on arrival.
    this.stats.correctionsSeek++;
    await this.serialise(async () => {
      this.applyingRemote = true;
      try {
        await a.seekTo(expectedAt(this.anchor, this.serverNow()) / 1000).catch(() => {});
      } finally {
        this.applyingRemote = false;
        const s = a.readState();
        this.detector.rebaseline(s.positionS, s.paused);
      }
    });
  }

  // --- the local loop -------------------------------------------------------

  private evalLoop(): void {
    if (this.running) {
      this.evalTimer = this.d.setTimer(() => this.evalLoop(), this.cfg.evalIntervalMs);
    }
    this.evaluate();
  }

  /** One evaluation. Run by the ~10 Hz timer and by any DOM event. */
  private evaluate(): void {
    if (this.status !== 'joined') return;

    const now = this.d.now();
    const state = this.d.adapter.readState();

    // The creator seeds the room from their own player, exactly once, as soon
    // as the clock is settled -- which is well inside `reconcileAfterMs`, so
    // they never see the room defend `paused@0` against them. See
    // `adoptLocalStateOnJoin`.
    if (this.pendingAdopt && this.clock.ready) {
      this.pendingAdopt = false;
      this.adoptLocalState(state);
    }

    const expected = this.clock.ready ? expectedAt(this.anchor, this.serverNow()) : null;
    const { observation, report } = this.detector.evaluate(state, expected, now);

    const onRoomMedia = this.onRoomMedia();
    if (!this.applyingRemote && !this.autoplayBlocked && onRoomMedia) {
      if (observation.kind === 'seek') {
        this.send('seek', observation.positionS * 1000);
      } else if (observation.kind === 'playstate') {
        if (observation.paused !== this.anchor.paused) {
          this.send(observation.paused ? 'pause' : 'play', observation.positionS * 1000);
          if (!observation.paused) this.holdForRoom();
        } else {
          // Agrees with the anchor: this is our own applied transition coming
          // back around, not user intent. The pause/play counterpart of the
          // two-diff test's roomDiff, and the reason echo suppression here is
          // structural rather than a timeout flag.
          this.stats.echoesSuppressed++;
        }
      }
    }

    // --- the anchor is truth, including about being paused ------------------
    if (
      this.clock.ready && onRoomMedia && !this.autoplayBlocked && !this.applyingRemote &&
      state.paused !== this.anchor.paused
    ) {
      if (this.disagreeingSince === 0) {
        this.disagreeingSince = now;
      } else if (now - this.disagreeingSince > this.cfg.reconcileAfterMs) {
        this.disagreeingSince = 0;
        this.stats.reconciles++;
        const epoch = this.epoch;
        void this.serialise(async () => {
          if (epoch !== this.epoch) return;
          await this.applyTransition(expectedAt(this.anchor, this.serverNow()), this.anchor.paused);
        });
      }
    } else {
      this.disagreeingSince = 0;
    }

    if (!report) return;

    if (report.readyState < 3 && report.bufferedAheadS >= TRANSIENT_UNREADY_MIN_AHEAD_S) {
      if (this.transientUnreadySince === 0) this.transientUnreadySince = now;
      if (now - this.transientUnreadySince < TRANSIENT_UNREADY_MS) {
        this.stats.reportsDeferred++;
        return;
      }
    } else {
      this.transientUnreadySince = 0;
    }

    // Watching something else is the same fact to the server as a suspended tab
    // or a refused autoplay: this member cannot follow the room and no
    // correction can change that. Absent, not behind.
    const absent = report.suspended || this.autoplayBlocked || !onRoomMedia;

    // An absent member is no longer judged, so any rate the servo left behind
    // would stick forever -- including onto whatever they navigate to next,
    // since a site that reuses its <video> element keeps its playbackRate. Hand
    // it back before going quiet.
    if (absent) this.releaseRate();
    const dueHeartbeat = now - this.lastHbAt >= this.cfg.hbIntervalMs;
    const anomaly =
      Math.abs(report.residualMs) >= this.cfg.reportThresholdMs ||
      report.paused !== this.anchor.paused;
    if (!dueHeartbeat && !(anomaly && now - this.lastReportAt >= this.cfg.minReportIntervalMs)) return;

    const hb: HbFrame = {
      t: 'hb',
      residualMs: Math.round(report.residualMs),
      slopeMsPerS: report.slopeMsPerS,
      positionMs: Math.round(report.positionMs),
      paused: report.paused,
      readyState: report.readyState,
      bufferedAheadS: report.bufferedAheadS,
      bufferedBehindS: report.bufferedBehindS,
      lastAppliedSeq: this.lastAppliedSeq,
      atServerMs: Math.round(this.serverNow()),
      uncertaintyMs: Math.round(this.clock.uncertaintyMs),
      rttMs: Math.round(this.clock.rttMs),
      clockSamples: this.clock.sampleCount,
      // Suspension and a refused autoplay are the same fact to the server: the
      // browser has taken playback away from this member and no correction can
      // give it back. Both mean absent, not behind -- do not gate the room for
      // them and do not seek them in circles.
      suspended: absent,
    };
    this.tx(hb);
    this.stats.reportsSent++;
    this.lastReportAt = now;
    if (dueHeartbeat) this.lastHbAt = now;
  }

  /**
   * Put a player the user just started back where the room still is, paused,
   * until the `play` it just sent comes back and starts everybody together.
   * See `holdLocalPlay`.
   *
   * Echo suppression is the same as for any applied transition: it runs under
   * `applyingRemote` and ends in `rebaseline(…, paused)`, so the pause it makes
   * is the detector's new baseline rather than an observation. No timeout flag
   * is involved, and nothing waits for the ack: whatever the room does next
   * -- our play, someone else's command, a play the gate holds or drops -- is
   * an ordinary scheduled transition, and until then the player agrees with
   * the anchor, so the reconciler has nothing to fight.
   *
   * The position is re-aimed more tightly than `seekToleranceMs` allows: the
   * user's gesture has already disturbed the picture, the player is paused,
   * and the whole lead is available to pay for an in-buffer seek (~100 ms on
   * Laftel). Starting from the anchor is what lets the transition land with no
   * seek. See HOLD_SEEK_TOLERANCE_MS for why not exactly.
   */
  private holdForRoom(): void {
    if (!this.cfg.holdLocalPlay || this.members.length < 2) return;
    this.stats.playsHeld++;
    const epoch = this.epoch;
    const seq = this.lastAppliedSeq;
    void this.serialise(async () => {
      // The room has moved since -- normally our own play landing already.
      // The player is doing what the room says; leave it.
      if (epoch !== this.epoch || this.lastAppliedSeq !== seq || !this.anchor.paused) return;
      await this.applyTransition(expectedAt(this.anchor, this.serverNow()), true, HOLD_SEEK_TOLERANCE_MS);
    });
  }

  /**
   * Hand back a playback rate the servo left on the player.
   *
   * Leaving the room used to keep whatever nudge was last in effect, so a
   * member who left kept watching at 1.036x on their own -- measured on
   * Laftel. Only a rate this engine set is undone: if the player's rate is
   * something else, somebody chose it after us and it is theirs.
   */
  private releaseRate(): void {
    if (this.rateWeSet === 1 || !this.d.adapter.capabilities.supportsPlaybackRateNudge) return;
    if (this.d.adapter.readState().rate === this.rateWeSet) this.d.adapter.setRate(1);
    this.rateWeSet = 1;
  }

  // --- outbound user intent -------------------------------------------------

  /**
   * Two commands, in this order, and both are needed.
   *
   * `play` only advances the anchor and clears `Paused` -- it does not carry a
   * position (`room.go:346`). Adopting with `play` alone would leave the anchor
   * at 0 and reproduce the same fight in a subtler form. `seek` is what
   * reanchors, and it preserves `Paused`, so a creator who is paused at 500 s
   * gets `paused@500s` from the one command.
   *
   * The room lands `CMD_DELAY` behind the still-advancing player, which costs
   * one correction -- the same thing any user seek during playback costs.
   */
  private adoptLocalState(s: PlayerState): void {
    this.seek(s.positionS);
    if (!s.paused) this.play();
  }

  private send(kind: CmdKind, positionMs: number, media?: { key: string; url?: string | undefined }): string {
    const reqId = `${this.selfId || 'x'}-${++this.reqSeq}`;
    this.tx({
      t: 'cmd', reqId, kind, positionMs: Math.round(positionMs),
      ...(media === undefined ? {} : { mediaKey: media.key }),
      ...(media?.url ? { mediaUrl: media.url } : {}),
    });
    this.stats.cmdsSent++;
    return reqId;
  }

  /** Explicit user actions, for UI buttons. Local detection covers the rest. */
  play(): string { return this.send('play', this.d.adapter.readState().positionS * 1000); }
  pause(): string { return this.send('pause', this.d.adapter.readState().positionS * 1000); }
  seek(positionS: number): string { return this.send('seek', positionS * 1000); }
  /** Point the room at other media. `mediaUrl` is where the others can open it. */
  setMedia(mediaKey: string, positionMs = 0, mediaUrl?: string): string {
    return this.send('media', positionMs, { key: mediaKey, url: mediaUrl });
  }
  chat(text: string): void { this.tx({ t: 'chat', text }); }
  rotateSecret(): void { this.tx({ t: 'rotate' }); }

  // --- introspection --------------------------------------------------------

  get state(): EngineStatus { return this.status; }
  get id(): string { return this.selfId; }
  get roster(): readonly MemberInfo[] { return this.members; }
  get currentAnchor(): Anchor { return this.anchor; }
  get appliedSeq(): number { return this.lastAppliedSeq; }
  get blocked(): boolean { return this.autoplayBlocked; }
  get mediaKey(): string { return this.localMediaKey; }
  /** True when this member is watching what the room is watching. */
  get followingRoom(): boolean { return this.onRoomMedia(); }
  /** The wire trace, oldest first. See `TraceEntry`. */
  get trace(): readonly TraceEntry[] { return this.traceRing; }

  /** Where the room should be right now, or null before the clock settles. */
  expectedMs(): number | null {
    return this.clock.ready ? expectedAt(this.anchor, this.serverNow()) : null;
  }
}
