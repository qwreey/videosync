/**
 * The sync engine: adapter + detector + clock + protocol, and nothing that
 * knows about a browser.
 *
 * Everything time-shaped is injected (`now`, `setTimer`, `clearTimer`,
 * `transport`, `isHidden`) so the engine runs unchanged in a browser, in a
 * userscript, and in a Node test against a real `videosyncd`.
 */
import type { ProviderAdapter } from '../adapter/types.ts';
import { AutoplayBlockedError } from '../adapter/types.ts';
import { SeekDetector } from '../detector/detector.ts';
import type { DetectorConfig } from '../detector/types.ts';
import { type Anchor, expectedAt, ServerClock } from './clock.ts';
import type {
  CmdKind, HbFrame, MemberInfo, ServerFrame,
} from './protocol.ts';
import type { Transport } from './transport.ts';

export interface EngineConfig {
  room: string;
  secret: string;
  name: string;
  /** Normalized provider+content identity. NOT the raw URL. */
  mediaKey: string;

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
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  rateMin: number;
  rateMax: number;
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
  reconnectBaseMs: 500,
  reconnectMaxMs: 15000,
  rateMin: 0.95,
  rateMax: 1.1,
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
}

export class SyncEngine {
  readonly cfg: EngineConfig;
  readonly clock = new ServerClock();
  readonly detector: SeekDetector;
  readonly stats: EngineStats = {
    cmdsSent: 0, statesApplied: 0, acksApplied: 0, correctionsSeek: 0,
    correctionsNudge: 0, nudgesUnsupported: 0, reportsSent: 0, timeSamples: 0,
    reconnects: 0, lateApplies: 0, echoesSuppressed: 0, badFrames: 0,
  };

  private readonly d: EngineDeps;
  private readonly ev: EngineEvents;

  private status: EngineStatus = 'idle';
  private selfId = '';
  private members: readonly MemberInfo[] = [];
  private anchor: Anchor = { positionMs: 0, atServerMs: 0, paused: true, mediaKey: '' };
  private lastAppliedSeq = 0;

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

  /** True once `play()` was refused for lack of a user gesture. */
  private autoplayBlocked = false;

  constructor(deps: EngineDeps, cfg: EngineConfig, events: EngineEvents = {}) {
    this.d = deps;
    this.cfg = cfg;
    this.ev = events;
    this.detector = new SeekDetector(deps.isHidden, {
      ...cfg.detector,
      evalIntervalMs: cfg.evalIntervalMs,
      reportThresholdMs: cfg.reportThresholdMs,
    });
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
    this.d.transport.connect({
      onOpen: () => this.onOpen(),
      onFrame: (f) => this.onFrame(f),
      onClose: (clean, reason) => this.onClose(clean, reason),
    });
  }

  private onOpen(): void {
    this.reconnectAttempt = 0;
    this.setStatus('joining');
    this.d.transport.send({
      t: 'hello', room: this.cfg.room, secret: this.cfg.secret,
      name: this.cfg.name, mediaKey: this.cfg.mediaKey,
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
    this.lastAppliedSeq = 0;
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
    this.d.transport.send({ t: 'time', t0: Math.round(this.d.now()) });
  }

  private timeLoop(): void {
    this.probeTime();
    this.timeTimer = this.d.setTimer(() => this.timeLoop(), this.cfg.timeSyncIntervalMs);
  }

  private serverNow(): number { return this.clock.serverNow(this.d.now()); }

  // --- inbound --------------------------------------------------------------

  private onFrame(f: ServerFrame): void {
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
        this.clock.addSample({ t0: f.t0, tRecv: f.tRecv, tSend: f.tSend, t1: this.d.now() });
        this.stats.timeSamples++;
        break;

      case 'state':
        this.schedule({ seq: f.seq, whenServerMs: f.when, anchor: f.anchor, kind: f.kind });
        this.stats.statesApplied++;
        break;

      case 'ack':
        // The originator's copy takes the SAME path. Excluding the sender from
        // the broadcast for echo suppression must not exclude it from the
        // simultaneity the timebase exists to provide.
        this.schedule({ seq: f.seq, whenServerMs: f.when, anchor: f.anchor, kind: f.kind });
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
    const delay = Math.max(0, this.clock.clientTime(next.whenServerMs) - this.d.now());
    this.applyTimer = this.d.setTimer(() => { void this.drain(); }, delay);
  }

  private async drain(): Promise<void> {
    this.applyTimer = 0;
    const serverNow = this.serverNow();
    while (this.pending.length > 0 && this.pending[0]!.whenServerMs <= serverNow) {
      const p = this.pending.shift()!;
      await this.applyScheduled(p);
    }
    this.rearm();
  }

  private async applyScheduled(p: Scheduled): Promise<void> {
    if (p.seq <= this.lastAppliedSeq) return;
    this.lastAppliedSeq = p.seq;
    this.anchor = p.anchor;
    this.ev.onAnchor?.(p.anchor);

    // If `when` has already passed -- the normal case on a slow link -- the
    // room has moved on since. Aim at where it is NOW, never at where it was
    // when the command was emitted. (The server-side twin of this bug made
    // every correction land one downlink delay behind.)
    const serverNow = this.serverNow();
    if (serverNow > p.whenServerMs + this.cfg.seekToleranceMs) this.stats.lateApplies++;
    const targetMs = expectedAt(p.anchor, Math.max(serverNow, p.anchor.atServerMs));
    await this.applyTransition(targetMs, p.anchor.paused);
  }

  private async applyTransition(targetMs: number, paused: boolean): Promise<void> {
    const a = this.d.adapter;
    this.applyingRemote = true;
    try {
      const cur = a.readState().positionS * 1000;
      if (Math.abs(cur - targetMs) > this.cfg.seekToleranceMs && a.capabilities.supportsDirectSeek) {
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
      throw e;
    }
  }

  /** Retry a refused play from inside a user gesture. */
  async resumeAfterGesture(): Promise<void> {
    if (!this.autoplayBlocked) return;
    await this.applyTransition(expectedAt(this.anchor, this.serverNow()), this.anchor.paused);
  }

  private async applyCorrection(mode: 'seek' | 'nudge', rate?: number): Promise<void> {
    const a = this.d.adapter;
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
      this.stats.correctionsNudge++;
      return;
    }
    // Re-derive the target here, at apply time, from our own anchor and clock.
    // The frame deliberately carries no position: one computed at send time is
    // stale by a downlink delay on arrival.
    this.stats.correctionsSeek++;
    this.applyingRemote = true;
    try {
      await a.seekTo(expectedAt(this.anchor, this.serverNow()) / 1000).catch(() => {});
    } finally {
      this.applyingRemote = false;
      const s = a.readState();
      this.detector.rebaseline(s.positionS, s.paused);
    }
  }

  // --- the local loop -------------------------------------------------------

  private evalLoop(): void {
    if (this.running) {
      this.evalTimer = this.d.setTimer(() => this.evalLoop(), this.cfg.evalIntervalMs);
    }
    if (this.status !== 'joined') return;

    const now = this.d.now();
    const state = this.d.adapter.readState();
    const expected = this.clock.ready ? expectedAt(this.anchor, this.serverNow()) : null;
    const { observation, report } = this.detector.evaluate(state, expected, now);

    if (!this.applyingRemote && !this.autoplayBlocked) {
      if (observation.kind === 'seek') {
        this.send('seek', observation.positionS * 1000);
      } else if (observation.kind === 'playstate') {
        if (observation.paused !== this.anchor.paused) {
          this.send(observation.paused ? 'pause' : 'play', observation.positionS * 1000);
        } else {
          // Agrees with the anchor: this is our own applied transition coming
          // back around, not user intent. The pause/play counterpart of the
          // two-diff test's roomDiff, and the reason echo suppression here is
          // structural rather than a timeout flag.
          this.stats.echoesSuppressed++;
        }
      }
    }

    if (!report) return;
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
      suspended: report.suspended || this.autoplayBlocked,
    };
    this.d.transport.send(hb);
    this.stats.reportsSent++;
    this.lastReportAt = now;
    if (dueHeartbeat) this.lastHbAt = now;
  }

  // --- outbound user intent -------------------------------------------------

  private send(kind: CmdKind, positionMs: number, mediaKey?: string): string {
    const reqId = `${this.selfId || 'x'}-${++this.reqSeq}`;
    this.d.transport.send({
      t: 'cmd', reqId, kind, positionMs: Math.round(positionMs),
      ...(mediaKey === undefined ? {} : { mediaKey }),
    });
    this.stats.cmdsSent++;
    return reqId;
  }

  /** Explicit user actions, for UI buttons. Local detection covers the rest. */
  play(): string { return this.send('play', this.d.adapter.readState().positionS * 1000); }
  pause(): string { return this.send('pause', this.d.adapter.readState().positionS * 1000); }
  seek(positionS: number): string { return this.send('seek', positionS * 1000); }
  setMedia(mediaKey: string, positionMs = 0): string {
    return this.send('media', positionMs, mediaKey);
  }
  chat(text: string): void { this.d.transport.send({ t: 'chat', text }); }
  rotateSecret(): void { this.d.transport.send({ t: 'rotate' }); }

  // --- introspection --------------------------------------------------------

  get state(): EngineStatus { return this.status; }
  get id(): string { return this.selfId; }
  get roster(): readonly MemberInfo[] { return this.members; }
  get currentAnchor(): Anchor { return this.anchor; }
  get appliedSeq(): number { return this.lastAppliedSeq; }
  get blocked(): boolean { return this.autoplayBlocked; }
  /** Where the room should be right now, or null before the clock settles. */
  expectedMs(): number | null {
    return this.clock.ready ? expectedAt(this.anchor, this.serverNow()) : null;
  }
}
