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
import type { DetectorConfig, Observation } from '../detector/types.ts';
import { DEFAULT_DETECTOR_CONFIG } from '../detector/types.ts';
import { type Anchor, expectedAt, ServerClock } from './clock.ts';
import type {
  ClientFrame, CmdKind, HbFrame, MemberInfo, ServerFrame,
} from './protocol.ts';
import type { Transport } from './transport.ts';

export interface EngineConfig {
  room: string;
  secret: string;
  name: string;
  /** Normalized provider+content identity. NOT the raw URL. Empty on a page
   *  that names no media, which never follows a room (see `onRoomMedia`). */
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
   * Seed the room from this member's own player, once, when its acquisition
   * of the video has settled (`STEADY`, docs/design/acquire.md) -- or, with no
   * gesture evidence, on the first settled evaluation. Set only by whoever
   * CREATED the room; a member who names a room that named nothing does the
   * same without it.
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
  /**
   * G: how long before an observation a trusted input may be and still be its
   * cause. Measured input -> media event: Laftel <= 50 ms, YouTube Space <= 50
   * and click <= 268 ms (it waits out a double click); a site's own autoplay
   * after a navigation click came >= 750 ms after it (BROWSER-FINDINGS §20).
   */
  gestureWindowMs: number;
  /**
   * T_settle: how long a player that agrees with the room stays `GUARDED`
   * after it was last conformed. Every site move measured came before
   * `canplaythrough` or within 11 ms of it (§20); this is the backstop for a
   * paused room whose site never moves, and exceeding it only degrades to
   * the behaviour before D8.
   */
  settleMs: number;
  /**
   * How close to the end a playing member counts as finished for the next
   * episode, when its element never reports `ended`. Neither measured site
   * needed it -- both route on well after `ended` (§20) -- so it is small.
   */
  endWindowMs: number;
  /** K: re-conforms in one media epoch before the engine stops fighting a site. */
  maxReconforms: number;
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
  gestureWindowMs: 500,
  settleMs: 1000,
  endWindowMs: 1000,
  maxReconforms: 3,
  detector: {},
};

/**
 * Where this member is in acquiring the video it is showing, per media epoch
 * (docs/design/acquire.md, research/design-acquire-video.md §4.2):
 *
 *  - `detached`: no usable element yet, or not the room's media. Nothing is
 *    applied; on the room's media the member reports itself acquiring.
 *  - `conforming`: the room's state is being put onto the element, once.
 *  - `guarded`: the element agrees with the room. A change nobody gestured
 *    for is the site's and is put back; a gestured one is the member's.
 *  - `steady`: the behaviour from before D8. Every change is the member's.
 *  - `fought`: the site kept overriding the room; the engine stopped fighting
 *    and reports the member absent until they press something.
 *
 * It only decides how an observation is CLASSIFIED -- nothing is silenced and
 * nothing waits on it: every way out of `guarded` is a condition or the
 * `settleMs` backstop, which leads to `steady`.
 */
export type AcquisitionState = 'detached' | 'conforming' | 'guarded' | 'steady' | 'fought';

/**
 * Evidence that the member, not the site, did something. Supplied by the app
 * layer from trusted input events (time only: no targets, no keys).
 */
export interface GestureEvidence {
  /** When the member last gave an activation-triggering input, on the `now()` clock. */
  lastInputAt(): number;
  /**
   * When the last input was that must NOT count -- one on VideoSync's own
   * panel. It still activates the page, so an activation edge right after it
   * is not a media key.
   */
  lastIgnoredInputAt(): number;
  /**
   * `navigator.userActivation.isActive`, or null where there is none. A rise
   * with no input behind it is a media key: Chromium activates the page for
   * an MPRIS play/pause, Firefox does not (BROWSER-FINDINGS §20).
   */
  activationActive(): boolean | null;
}

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
  /** The acquisition state changed. `fought` is worth telling the member. */
  onAcquisition?(s: AcquisitionState): void;
}

export interface EngineDeps {
  adapter: ProviderAdapter;
  transport: Transport;
  /** Monotonic milliseconds. Used for the clock estimate AND for scheduling. */
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(h: number): void;
  isHidden(): boolean;
  /**
   * Gesture evidence (see `GestureEvidence`). Without it the engine cannot
   * tell a site's autoplay from a member's press, counts every change as the
   * member's, and skips the acquisition states -- which is how it behaved
   * before D8. Both shims supply it.
   */
  gestures?: GestureEvidence;
  /**
   * Whether `nextKey` is the natural continuation of `prevKey`
   * (`continuesMedia` in mediakey.ts). Absent: never, so a member's own
   * navigation never moves the room without a press.
   */
  continues?(prevKey: string, nextKey: string): boolean;
  /**
   * A server-access ticket for the next `hello`, fetched before every connect
   * (docs/design/auth.md). '' when the server wants none; a plain string
   * (not a promise) when the answer is known without asking.
   *
   * A ticket is single-use and lives a minute, so one is never kept for a
   * reconnect. A rejection whose `code` is `auth_required` means signing in
   * is needed: the session is refused, like a wrong secret, rather than
   * retried into the same answer. Any other rejection is a network failure
   * and takes the ordinary reconnect path. Absent, a connect is exactly what
   * it always was.
   */
  ticket?(): Promise<string> | string;
}

/** How long a connect waits for its ticket before it counts as a network failure. */
export const TICKET_TIMEOUT_MS = 20_000;

/** What a ticket source rejects with when only signing in can help. */
export function isAuthRequired(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'auth_required';
}

interface Scheduled {
  seq: number;
  /** The server's answer to one of our own commands. */
  own?: boolean;
  whenServerMs: number;
  /** When the server emitted it. Equal to `when` for a command applied with no
   *  lead, which is how a genuinely late apply stays distinguishable from one
   *  that was never scheduled ahead at all. */
  emittedAtServerMs: number;
  anchor: Anchor;
  kind: string;
  /** Our own ack, with a later `play` of ours still on its way. See `ownAck`. */
  beforeOwnPlay?: boolean;
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
  /** A ticket could not be had for a network reason, or in time. The network's doing, not ours. */
  ticketFailures: number;
  /** play() failed for a reason that is not an autoplay refusal. */
  playFailures: number;
  /** Local plays re-paused to wait for the room's `when` (`holdLocalPlay`). */
  playsHeld: number;
  /** Reports held back because the player looked unready mid-seek. */
  reportsDeferred: number;
  /** Times the player disagreed with the anchor long enough to be re-applied. */
  reconciles: number;
  /** Times the media in the element changed under the engine (see `mediaEpoch`). */
  mediaEpochs: number;
  /** Media epochs that got as far as being conformed or adopted. */
  acquisitions: number;
  /** Changes a site made on its own while guarded, and that were put back or absorbed. */
  siteMovesAbsorbed: number;
  /** Changes nobody gestured for while acquiring, and that were not sent. */
  ungesturedIgnored: number;
  /** Changes a gesture accounted for while acquiring, and that were sent. */
  gesturedIntents: number;
  /** Epochs in which the engine gave up fighting the site. */
  fought: number;
  /** Pauses made by the end of the media, which are not a member's pause. */
  endsNotSent: number;
  /** Our conditional `media` commands the room had already moved past. */
  mediaStale: number;
  /** Next-episode continuations sent. */
  continuations: number;
  /** Rooms that named nothing, named by this member. */
  namings: number;
  /** Times this member seeded the room from its own player. */
  adoptions: number;
  /** Scheduled transitions not applied because the conform step will. */
  skippedAcquiring: number;
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

/**
 * How long one of our own commands counts as on its way back.
 *
 * An ack returns within a round trip. A command that gets none was dropped --
 * rate-limited, or a held play superseded -- and must not go on shaping how
 * later ones are applied. This only decides how a local play is held; nothing
 * about echo suppression depends on it.
 */
const OWN_ACK_WAIT_MS = 5000;

/**
 * How long after its own end a member's site may move on and still carry the
 * room with it. Measured: Laftel routes ~5.5 s after `ended`, YouTube's
 * autonav ~7.6 s (BROWSER-FINDINGS §20). A navigation later than this was
 * somebody's choice, and gets the "move the room here" button instead.
 */
const CONTINUATION_WINDOW_MS = 20_000;

/**
 * A room position this far past the element's duration is not on this
 * element's timeline -- an ad, a preview, a room that has already finished --
 * and conforming would only seek it to its end.
 */
const PAST_DURATION_SLACK_MS = 2000;
/**
 * How long a continuation of ours may take to reach the room and be conformed
 * before it no longer starts the room. The conform waits for the ack and for
 * the new element's data (at most `METADATA_ONLY_MS` past its metadata); a
 * minute is far more than that, and far less than the time after which
 * somebody moving the room onto the next episode by hand is a new decision.
 */
const CONTINUATION_START_MS = 60_000;

/**
 * Conform a paused element that has metadata but will not buffer on its own
 * (`preload="metadata"`) after this long. Before that, conforming waits for
 * HAVE_FUTURE_DATA, because Laftel writes its resume position again and again
 * from `loadedmetadata` until up to 0.5 s before `canplaythrough` -- 1.5 to
 * 1.8 s -- and a conform in that window is fought (BROWSER-FINDINGS §20).
 */
const METADATA_ONLY_MS = 5000;

/** One media epoch's acquisition. See `AcquisitionState`. */
interface Acquisition {
  id: number;
  startedAt: number;
  state: AcquisitionState;
  /** `adopt`: this member seeds the room from its player instead of conforming. */
  policy: 'conform' | 'adopt' | null;
  reconforms: number;
  /** When the player last finished being conformed (or started being guarded). */
  guardedAt: number;
  /** When the element was first seen with metadata in this epoch, or 0. */
  metadataAt: number;
  /**
   * The element is loaded and the room is more than PAST_DURATION_SLACK_MS
   * past its end: not the room's media (an ad, a preview), so not on the
   * room's timeline. Left alone, and absent rather than acquiring.
   */
  pastEnd: boolean;
}

/** What an in-flight applied transition is making the player do. */
interface Applying {
  /** Where it is seeking to. */
  targetMs: number;
  /** The pause state it leaves behind. */
  paused: boolean;
}

/**
 * Where an element puts a seek to `targetMs`: per spec, one before the start
 * lands on 0 and one past the end on the duration.
 *
 * A seek of the engine's is recognised mid-flight by where it lands, and a room
 * that is past this member's end would otherwise look like a user scrubbing to
 * the end -- sent, it moves the whole room there. The same rule
 * `Html5Adapter.seekTo` resolves by. A live or DRM stream's seekable window can
 * clamp tighter than this, and nothing in `PlayerState` says where.
 */
function landsAt(targetMs: number, durationS: number): number {
  const t = Math.max(targetMs, 0);
  return Number.isFinite(durationS) && durationS > 0 ? Math.min(t, durationS * 1000) : t;
}

/** One of our own commands, sent and not yet acked. */
interface OwnCmd { reqId: string; kind: CmdKind; at: number }

export class SyncEngine {
  readonly cfg: EngineConfig;
  readonly clock = new ServerClock();
  readonly detector: SeekDetector;
  readonly stats: EngineStats = {
    cmdsSent: 0, statesApplied: 0, acksApplied: 0, correctionsSeek: 0,
    correctionsNudge: 0, nudgesUnsupported: 0, reportsSent: 0, timeSamples: 0,
    reconnects: 0, lateApplies: 0, echoesSuppressed: 0, badFrames: 0,
    skippedOffMedia: 0, supersededApplies: 0, connectFailures: 0, ticketFailures: 0,
    playFailures: 0, playsHeld: 0, reportsDeferred: 0, reconciles: 0,
    mediaEpochs: 0, acquisitions: 0, siteMovesAbsorbed: 0, ungesturedIgnored: 0,
    gesturedIntents: 0, fought: 0, endsNotSent: 0, mediaStale: 0, continuations: 0,
    namings: 0, adoptions: 0, skippedAcquiring: 0,
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
   * seeks, `rebaseline(pos, paused)` for play/pause. This is set solely for
   * the window in which an async seek is in flight, and nothing may be
   * load-bearing on it: syncwatch ships a load-bearing ignore-flag and it
   * deadlocks silently and forever (`content.ts:87-104`).
   *
   * It is not a mute either. It says what the engine is doing to the player,
   * so an observation in that window that is neither the transition's own
   * effect nor the room's state is still the user's, and is sent. Muting the
   * window lost every gesture made during a slow seek -- and the rebaseline
   * at its end then adopted them silently, for the reconciler to undo.
   */
  private applyingRemote: Applying | null = null;
  /** `DetectorConfig.seekThresholdMs`, for judging a seek made mid-apply. */
  private readonly seekThresholdMs: number;
  /**
   * The current room secret: the one joined with, until the room rotates it.
   * Every reconnect's `hello` is checked against the server's CURRENT secret.
   */
  private secret: string;
  /** Our own commands on their way back, oldest first. See `OWN_ACK_WAIT_MS`. */
  private unacked: OwnCmd[] = [];
  /** The ticket for the `hello` about to be sent, spent by sending it. */
  private ticket = '';
  /**
   * Bumped by every connect and by `stop()`. A ticket arrives
   * asynchronously, and one that lands after its connect was abandoned must
   * not open a socket.
   */
  private connectGen = 0;
  /** A click to sync arrived when there was no session to sync to. */
  private gestureRetryPending = false;

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
  /**
   * The room media this member seeds from its own player, or null: the
   * creator's media, or media this member named. See `adoptLocalStateOnJoin`.
   */
  private adoptFor: string | null = null;
  /**
   * The media epoch: bumped on anything that changes WHICH media is in the
   * element -- the element replaced or gone, `emptied`/`loadstart` on it, the
   * page's media key, the room's. The bump resets the detector synchronously,
   * inside the handler, so no observation can straddle two media: YouTube
   * calls `play()` 1 ms after `emptied` (BROWSER-FINDINGS §20).
   */
  private acq: Acquisition = {
    id: 0, startedAt: 0, state: 'detached', policy: null, reconforms: 0, guardedAt: 0, metadataAt: 0, pastEnd: false,
  };
  /** A conform of the current epoch is queued or running. */
  private conformInFlight = false;
  /** The last time this member's element reached (or nearly reached) the room's media's end. */
  private lastFinish: { key: string; epoch: number; at: number } | null = null;
  /** Our next-episode continuation, until it is conformed and the room is started. */
  private continuing: { key: string; play: boolean; at: number } | null = null;
  /** A `welcome` has been applied in this engine's life: the next one is a reconnect. */
  private welcomed = false;
  /** The local media this member already tried to name an unnamed room with. */
  private namedFor = '';
  /**
   * Somebody else's command moved the room since this member set out to seed
   * it (joined as creator, or named the room). From then on that choice
   * stands and this member conforms. Recorded when the command is applied,
   * whatever acquisition state it finds -- a creator still loading skips it,
   * and must still know it happened.
   */
  private foreignMove = false;
  /**
   * Seqs the server acked as ours. A `resync` of our own command can be
   * applied before the ack that carries the same seq (the ack waits for its
   * `when`), and must not count as somebody else's move.
   */
  private ownSeqs = new Set<number>();
  /** Until when an in-transit member reports itself acquiring. */
  private inTransitUntil = 0;
  /**
   * Finished on the media the room just left, and not yet on the new one:
   * on the way there, so present-but-unready rather than absent.
   */
  private inTransit = false;
  /** `activationActive()` at the last sample, and when it last rose with no input. */
  private prevActivation = false;
  private activationEdgeAt = -Infinity;
  /** What the last report said about acquiring, so a change is reported at once. */
  private lastAcquiringSent = false;

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
    for (const k of ['seq', 'when', 'kind', 'positionMs', 'mode', 'rate', 'code', 'reqId', 'mediaKey', 'mediaUrl', 'ifMediaKey', 'acquiring', 'finished'] as const) {
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
    this.adoptFor = cfg.adoptLocalStateOnJoin ? cfg.mediaKey : null;
    this.acq.startedAt = deps.now();
    if (!this.gating()) this.acq.state = 'steady';
    this.detector = new SeekDetector(deps.isHidden, {
      ...cfg.detector,
      evalIntervalMs: cfg.evalIntervalMs,
      reportThresholdMs: cfg.reportThresholdMs,
    });
    this.seekThresholdMs = cfg.detector.seekThresholdMs ?? DEFAULT_DETECTOR_CONFIG.seekThresholdMs;
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
    // The load algorithm ran on the element: new media, same element. It set
    // `paused` without a `pause` event and dropped the position to 0, which the
    // detector would otherwise read as a seek to 0 on the media we were on.
    for (const ev of ['emptied', 'loadstart'] as const) {
      unsubs.push(deps.adapter.on(ev, () => {
        this.newMediaEpoch();
        if (this.running) this.evaluate();
      }));
    }
    const unsubReplaced = deps.adapter.on('elementreplaced', () => {
      this.newMediaEpoch();
      if (this.gating()) return; // `conforming` puts the new element where the room is
      // Without gesture evidence: if we are still on the room's media, put the
      // new element where the room is. If we are not, leave it alone --
      // snapping someone's next episode to the old one's timestamp is worse
      // than doing nothing.
      //
      // Checked again when the work runs, not only here: this fires inside
      // `setTarget`, and a navigation retargets the element BEFORE it names the
      // new media, so at this instant we can still believe we are on the room's.
      const epoch = this.epoch;
      if (this.canAim(epoch)) {
        void this.serialise(async () => {
          if (!this.canAim(epoch)) return;
          await this.applyTransition(
            expectedAt(this.anchor, this.serverNow()), this.anchor.paused,
            this.cfg.seekToleranceMs, () => this.canAim(epoch));
        });
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
    const prev = this.localMediaKey;
    this.localMediaKey = key;
    // A seed is for the media it was taken on; sent after a navigation it would
    // restart a room somebody has since chosen a state for.
    this.adoptFor = null;
    this.inTransit = false;
    this.newMediaEpoch();
    this.maybeContinue(prev, key);
  }

  /**
   * Whether this member's own navigation from `prev` to `key` carries the room
   * with it: the next episode, which the site moved on to by itself at the end
   * of the room's media. Everything else keeps the "move the room here"
   * button (D4) -- with no host, an accidental navigation must not drag
   * everybody along.
   *
   * Sent as a compare-and-set on `prev`: every member whose site moved on
   * sends the same, exactly one wins, and the rest follow the room.
   */
  private maybeContinue(prev: string, key: string): void {
    const f = this.lastFinish;
    this.lastFinish = null;
    if (this.status !== 'joined' || !f || f.key !== prev || prev !== this.anchor.mediaKey) return;
    if (this.d.now() - f.at > CONTINUATION_WINDOW_MS) return;
    if (!key || !this.d.continues?.(prev, key)) return;
    // It lands paused at 0 -- the sender's own site may be seconds into the
    // new episode -- and the room is started once this member is conformed,
    // by a `play` the readiness gate holds for everyone still on the way.
    this.continuing = { key, play: !this.anchor.paused, at: this.d.now() };
    this.stats.continuations++;
    this.send('media', 0, { key, url: this.localMediaUrl }, prev);
  }

  /** Whether the acquisition states are in force. See `EngineDeps.gestures`. */
  private gating(): boolean { return this.d.gestures !== undefined; }

  private setAcq(state: AcquisitionState): void {
    if (this.acq.state === state) return;
    this.acq.state = state;
    this.ev.onAcquisition?.(state);
  }

  /** See `acq`. */
  private newMediaEpoch(): void {
    const now = this.d.now();
    this.acq = {
      id: this.acq.id + 1, startedAt: now, state: this.gating() ? 'detached' : 'steady',
      policy: null, reconforms: 0, guardedAt: 0, metadataAt: 0, pastEnd: false,
    };
    this.conformInFlight = false;
    this.detector.reset();
    this.disagreeingSince = 0;
    this.stats.mediaEpochs++;
    this.ev.onAcquisition?.(this.acq.state);
  }

  /**
   * Whether we are watching what the room is watching.
   *
   * A member on different media cannot follow the room and must not steer it:
   * their position is measured against a different timeline, so every command
   * they send and every residual they report is meaningless to everyone else.
   *
   * An empty key is "nothing", not "not established yet", and nothing is never
   * the room's media -- not even a room whose own key is empty. Both keys come
   * from a URL, so empty means a page that names no media: a site's front
   * page, YouTube's search or channel pages. Treating it as a match drove
   * whatever `<video>` such a page happens to hold -- a hover preview, a
   * channel trailer -- to the room's anchor, and sent that element's own jumps
   * to the room as seeks. A room created with no media is followed by nobody
   * until a `media` command names some.
   */
  private onRoomMedia(): boolean {
    return this.localMediaKey !== '' && this.localMediaKey === this.anchor.mediaKey;
  }

  /**
   * Whether the room's position may be put onto the player right now, by work
   * queued in session `epoch`.
   *
   * Asked when the work is queued AND when it runs: a mutation can wait behind
   * a seek for ten seconds, and in that time the session can end (after which
   * it would move the player of somebody who left), the clock can be reset by
   * a reconnect (after which `expected()` of a playing anchor is ~-1.8e12 ms,
   * which an element clamps to 0), or the member can navigate to other media.
   * Joined is not enough on its own: `welcome` arrives before the probes that
   * settle the clock.
   */
  private canAim(epoch: number): boolean {
    return epoch === this.epoch && this.status === 'joined' &&
      this.clock.ready && this.onRoomMedia();
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
    this.unacked = [];
    this.gestureRetryPending = false;
    this.connectGen++;
    this.ticket = '';
    this.d.transport.close();
    this.setStatus('closed');
  }

  private connect(): void {
    this.setStatus('connecting');
    const gen = ++this.connectGen;
    if (!this.d.ticket) {
      this.openTransport();
      return;
    }
    let got: Promise<string> | string;
    try {
      got = this.d.ticket();
    } catch (e) {
      got = Promise.reject(e);
    }
    if (typeof got === 'string') {
      // Known without asking -- usually '' for a server that wants none -- so
      // the connect stays synchronous, exactly as without a ticket source.
      this.ticket = got;
      this.openTransport();
      return;
    }
    // A server that accepts the connection and never answers must not leave
    // the session on "connecting" with no reconnect armed: past the deadline
    // the attempt counts as a network failure, and a late answer is dropped.
    let settled = false;
    const fail = (msg: string) => {
      this.stats.ticketFailures++;
      this.onClose(false, `ticket: ${msg}`);
    };
    const deadline = this.d.setTimer(() => {
      if (settled || gen !== this.connectGen || !this.running) return;
      settled = true;
      fail(`no answer within ${TICKET_TIMEOUT_MS} ms`);
    }, TICKET_TIMEOUT_MS);
    got.then((t) => {
      if (settled) return;
      settled = true;
      this.d.clearTimer(deadline);
      if (gen !== this.connectGen || !this.running) return;
      this.ticket = t;
      this.openTransport();
    }, (e: unknown) => {
      if (settled) return;
      settled = true;
      this.d.clearTimer(deadline);
      if (gen !== this.connectGen || !this.running) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (isAuthRequired(e)) {
        // Nothing a retry can fix: the same request gets the same answer
        // until somebody signs in. The app decides what happens then.
        this.setStatus('refused', 'auth_required');
        this.ev.onError?.('auth_required', msg);
        return;
      }
      fail(msg);
    });
  }

  private openTransport(): void {
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
    const ticket = this.ticket;
    this.ticket = '';
    this.tx({
      // Not `cfg.secret`: after a rotation the server accepts only the new one,
      // and a refused reconnect ends the session for good.
      t: 'hello', room: this.cfg.room, secret: this.secret,
      name: this.cfg.name,
      // The CURRENT media, not the one we joined with: a reconnect after a
      // navigation would otherwise announce the wrong thing.
      mediaKey: this.localMediaKey,
      ...(this.localMediaUrl ? { mediaUrl: this.localMediaUrl } : {}),
      ...(ticket ? { ticket } : {}),
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
    // Whatever the old socket was carrying back will never arrive.
    this.unacked = [];
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
      case 'welcome': {
        // A welcome replaces the anchor without passing through
        // `applyScheduled`, so what that step learns from a command has to be
        // learned here from the commands missed while away: that somebody
        // else moved the room (a seeder must not seed over it), and that the
        // room's media changed. A seq of ours that the server applied just
        // before the socket went is indistinguishable from somebody else's
        // unless its ack made it; conforming to our own seed is harmless.
        if (f.seq > this.lastAppliedSeq && !this.ownSeqs.has(f.seq) && this.adoptFor !== null) {
          this.foreignMove = true;
        }
        const left = this.anchor.mediaKey;
        this.selfId = f.you;
        this.members = f.members;
        this.anchor = f.anchor;
        this.lastAppliedSeq = f.seq;
        // The first welcome is not a change: the anchor before it is a
        // placeholder, and a new epoch would disown a press made before it.
        if (this.welcomed && f.anchor.mediaKey !== left) this.roomMediaChanged(left);
        this.welcomed = true;
        // A continuation is either on the room now, or lost with the socket
        // (or refused), and then it must not start the room whenever somebody
        // later moves it onto that media.
        if (this.continuing && this.continuing.key !== f.anchor.mediaKey) this.continuing = null;
        // A naming lost with the old connection (dropped before the server
        // applied it) is tried again against the room as it is now; the
        // compare-and-set makes a repeat harmless.
        this.namedFor = '';
        this.setStatus('joined');
        this.ev.onMembers?.(f.members);
        this.ev.onAnchor?.(f.anchor);
        // Do NOT snap the player here: the offset has not settled yet, so
        // expected() is not yet meaningful. The first heartbeat's residual
        // brings us in, judged by a server that knows our uncertainty.
        break;
      }

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
        this.ownSeqs.add(f.seq);
        if (this.ownSeqs.size > 64) this.ownSeqs.delete(this.ownSeqs.values().next().value!);
        this.schedule({
          seq: f.seq, whenServerMs: f.when, emittedAtServerMs: f.emittedAt,
          anchor: f.anchor, kind: f.kind, beforeOwnPlay: this.ownAck(f.reqId), own: true,
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
        if (f.code === 'media_stale') {
          // Our conditional `media` lost a race: the room had already moved.
          // Nothing to undo -- we follow the room as it is. Refusals carry no
          // reqId; the server answers in order, so it is our oldest one.
          this.stats.mediaStale++;
          const i = this.unacked.findIndex((c) => c.kind === 'media');
          if (i >= 0) this.unacked.splice(i, 1);
          this.continuing = null;
          // A seed of ours that lost is dropped by `foreignMove`: the
          // winner's state reaches us as somebody else's command.
          break;
        }
        if (f.code === 'join_refused' || f.code === 'room_full' || f.code === 'auth_required') {
          this.setStatus('refused', f.code);
        }
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
      this.applyTimer = this.d.setTimer(() => this.drain(), this.cfg.evalIntervalMs);
      return;
    }
    const delay = Math.max(0, this.clock.clientTime(next.whenServerMs) - this.d.now());
    this.applyTimer = this.d.setTimer(() => this.drain(), delay);
  }

  /**
   * Hand every due transition to the player queue, without waiting for any of
   * them to finish.
   *
   * Waiting here held up the NEXT command's bookkeeping for as long as the
   * previous one's seek took -- up to ten seconds. Meanwhile the heartbeat
   * reported the old seq, the anchor said the room was still doing what it had
   * stopped doing, and when the seek ended the stale transition's play() ran
   * because nothing newer had been recorded to supersede it.
   */
  private drain(): void {
    this.applyTimer = 0;
    if (!this.clock.ready) { this.rearm(); return; } // nothing can be scheduled yet
    const serverNow = this.serverNow();
    while (this.pending.length > 0 && this.pending[0]!.whenServerMs <= serverNow) {
      void this.applyScheduled(this.pending.shift()!);
    }
    this.rearm();
  }

  /**
   * The room's media changed from `left` to what the anchor names now.
   * Whatever the element shows is acquired afresh against the new media: the
   * room moving onto our page is a new media epoch as much as our page moving
   * is.
   */
  private roomMediaChanged(left: string): void {
    const f = this.lastFinish;
    // Only a finish that just happened: a member idle on an end screen for
    // minutes is not on its way to whatever the room moved to, and would
    // hold its next play for GATE_TIMEOUT.
    const now = this.d.now();
    this.inTransit = !!f && f.key === left && !this.onRoomMedia() && now - f.at <= CONTINUATION_WINDOW_MS;
    this.inTransitUntil = now + CONTINUATION_WINDOW_MS;
    this.newMediaEpoch();
  }

  private applyScheduled(p: Scheduled): Promise<void> {
    if (p.seq <= this.lastAppliedSeq) return Promise.resolve();
    // Bookkeeping is synchronous even though the player work is queued, so a
    // command that arrives while an earlier one is still touching the player
    // knows it has been superseded.
    this.lastAppliedSeq = p.seq;
    if (!p.own && !this.ownSeqs.has(p.seq) && this.adoptFor !== null) this.foreignMove = true;
    const roomMoved = p.anchor.mediaKey !== this.anchor.mediaKey;
    const left = this.anchor.mediaKey;
    this.anchor = p.anchor;
    if (roomMoved) this.roomMediaChanged(left);
    this.ev.onAnchor?.(p.anchor);

    // Track the room's state, but do not move a player that is showing
    // different media: the room's position means nothing on our timeline.
    if (!this.onRoomMedia()) {
      this.stats.skippedOffMedia++;
      return Promise.resolve();
    }
    // Not yet acquired: the conform step reads the anchor when it runs, so
    // applying this too would only move the player twice. A player the site
    // took over is left alone as well, until the member takes it back.
    if (this.acq.state === 'detached' || this.acq.state === 'conforming' || this.acq.state === 'fought') {
      this.stats.skippedAcquiring++;
      return Promise.resolve();
    }

    const epoch = this.epoch;
    const media = this.acq.id;
    const current = (): boolean => this.canAim(epoch) && p.seq === this.lastAppliedSeq && media === this.acq.id;
    return this.serialise(async () => {
      if (epoch === this.epoch && !this.onRoomMedia()) {
        // The member navigated away while this waited.
        this.stats.skippedOffMedia++;
        return;
      }
      if (!current()) {
        // The session ended while this was queued -- a reconnect, or the user
        // left -- or something newer took over. Acting now would move a player
        // nobody is watching with us, or move it backwards into a state the
        // room has left.
        this.stats.supersededApplies++;
        return;
      }
      let toleranceMs = this.cfg.seekToleranceMs;
      if (p.beforeOwnPlay && p.anchor.paused) {
        // Our own seek or pause, with our own play right behind it -- the
        // creator's adoption is exactly this. Applied alone, it pauses a player
        // the user has just set going, only for the play to start it again. In
        // a room that holds a local play, this pause IS that hold, and it is
        // aimed as tightly; in one that does not, there is nothing to do.
        if (!this.holdsLocalPlay()) {
          this.stats.supersededApplies++;
          return;
        }
        toleranceMs = HOLD_SEEK_TOLERANCE_MS;
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
      await this.applyTransition(targetMs, p.anchor.paused, toleranceMs, current);
    });
  }

  /**
   * @param current asked again once the seek is done. A seek can be parked for
   *   ten seconds, and whatever superseded this transition in that time has its
   *   own work queued behind; pressing play or pause now would only be undone
   *   by it, after the member had seen it.
   */
  private async applyTransition(
    targetMs: number, paused: boolean, toleranceMs: number, current: () => boolean,
  ): Promise<void> {
    const a = this.d.adapter;
    this.applyingRemote = { targetMs, paused };
    try {
      const cur = a.readState().positionS * 1000;
      if (Math.abs(cur - targetMs) > toleranceMs && a.capabilities.supportsDirectSeek) {
        await a.seekTo(targetMs / 1000).catch(() => { /* a stalled seek is reported, not thrown */ });
      }
      if (!current()) {
        this.stats.supersededApplies++;
        return;
      }
      if (paused) {
        await a.pause();
      } else {
        await this.tryPlay();
      }
    } finally {
      this.applyingRemote = null;
      const s = a.readState();
      // Rebaseline with what the player ACTUALLY did, including its pause
      // state -- that is what keeps our own transition from coming back around
      // as user intent. Anything the user did meanwhile was already judged and
      // sent by `evaluate`, so adopting it here loses nothing.
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
   *
   * A click with no session to sync to -- the overlay stays up through a
   * reconnect -- is remembered rather than acted on: aiming at the room with a
   * reset clock seeks to the start of the video and plays from there. The
   * first evaluation that can aim again retries it; the page has had its
   * gesture by then.
   */
  async resumeAfterGesture(): Promise<void> {
    if (!this.autoplayBlocked) {
      this.gestureRetryPending = false;
      return;
    }
    if (this.anchor.paused) {
      this.autoplayBlocked = false;
      this.gestureRetryPending = false;
      return;
    }
    const epoch = this.epoch;
    if (!this.canAim(epoch)) {
      this.gestureRetryPending = true;
      return;
    }
    this.gestureRetryPending = false;
    await this.serialise(async () => {
      if (!this.canAim(epoch)) {
        this.gestureRetryPending = true;
        return;
      }
      await this.applyTransition(
        expectedAt(this.anchor, this.serverNow()), this.anchor.paused,
        this.cfg.seekToleranceMs, () => this.canAim(epoch));
    });
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
    // Judged on a report sent before we started acquiring: stale, and the
    // conform step is about to do better. Hidden or not: a hidden seeder moved
    // to the room's placeholder would seed the room from there.
    if (this.unacquired()) return;
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
    const epoch = this.epoch;
    const media = this.acq.id;
    await this.serialise(async () => {
      // ...and ask both guards again: this can wait behind a ten-second seek.
      if (!this.canAim(epoch) || media !== this.acq.id) {
        this.stats.supersededApplies++;
        return;
      }
      const targetMs = expectedAt(this.anchor, this.serverNow());
      // A correction leaves the pause state alone, so the one it "makes" is
      // the room's.
      this.applyingRemote = { targetMs, paused: this.anchor.paused };
      try {
        await a.seekTo(targetMs / 1000).catch(() => {});
      } finally {
        this.applyingRemote = null;
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
    this.sampleActivation(now);

    this.nameRoomIfUnnamed(state);
    this.trackFinish(now, state);
    this.advanceAcquisition(now, state);

    // Without gesture evidence there is no acquisition to settle, so the
    // creator seeds the room from their own player as soon as the clock is
    // settled -- which is well inside `reconcileAfterMs`, so they never see the
    // room defend `paused@0` against them. See `adoptLocalStateOnJoin`.
    //
    // Consumed even when the creator is not on the room's media, and then not
    // acted on: a page that names no media has nothing to seed the room from.
    if (!this.gating() && this.adoptFor !== null && this.clock.ready) {
      const k = this.adoptFor;
      this.adoptFor = null;
      if (this.onRoomMedia() && k === this.anchor.mediaKey) {
        this.stats.adoptions++;
        this.adoptLocalState(state);
      }
    }
    // A click to sync that came with no session to sync to. See resumeAfterGesture.
    if (this.gestureRetryPending && this.canAim(this.epoch)) void this.resumeAfterGesture();

    const expected = this.clock.ready ? expectedAt(this.anchor, this.serverNow()) : null;
    const { observation, report } = this.detector.evaluate(state, expected, now);

    const onRoomMedia = this.onRoomMedia();
    if (!this.autoplayBlocked && onRoomMedia && SeekDetector.isUserIntent(observation)) {
      this.classify(observation, state, now);
    }

    // --- the anchor is truth, including about being paused ------------------
    // Only once acquired: until then the conform step and `guarded` do this,
    // and a player at its end is finished, not paused -- play() on an ended
    // element starts it again from the beginning.
    if (
      this.clock.ready && onRoomMedia && !this.autoplayBlocked && !this.applyingRemote &&
      this.acq.state === 'steady' && !state.ended && state.paused !== this.anchor.paused
    ) {
      if (this.disagreeingSince === 0) {
        this.disagreeingSince = now;
      } else if (now - this.disagreeingSince > this.cfg.reconcileAfterMs) {
        this.disagreeingSince = 0;
        this.stats.reconciles++;
        const epoch = this.epoch;
        const media = this.acq.id;
        void this.serialise(async () => {
          if (!this.canAim(epoch) || media !== this.acq.id) return;
          await this.applyTransition(
            expectedAt(this.anchor, this.serverNow()), this.anchor.paused,
            this.cfg.seekToleranceMs, () => this.canAim(epoch) && media === this.acq.id);
        });
      }
    } else {
      this.disagreeingSince = 0;
    }

    if (!report) return;

    const acquiring = this.acquiring();
    const finished = onRoomMedia && state.ended === true;
    if (!acquiring && report.readyState < 3 && report.bufferedAheadS >= TRANSIENT_UNREADY_MIN_AHEAD_S) {
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
    // correction can change that. Absent, not behind. So is a member whose
    // video has ended, one whose site took the player over, and one that would
    // be acquiring but for a hidden tab (see `unacquired`).
    const absent = !acquiring && (
      report.suspended || this.autoplayBlocked || !onRoomMedia || finished || this.acq.state === 'fought' ||
      (this.acq.state === 'detached' && this.acq.pastEnd) || this.unacquired());

    // An absent member is no longer judged, so any rate the servo left behind
    // would stick forever -- including onto whatever they navigate to next,
    // since a site that reuses its <video> element keeps its playbackRate. Hand
    // it back before going quiet.
    if (absent) this.releaseRate();
    const dueHeartbeat = now - this.lastHbAt >= this.cfg.hbIntervalMs;
    const anomaly =
      Math.abs(report.residualMs) >= this.cfg.reportThresholdMs ||
      report.paused !== this.anchor.paused;
    // Starting or stopping acquiring is reported at once: it is what holds and
    // releases a play for this member.
    const acquiringChanged = acquiring !== this.lastAcquiringSent;
    if (!dueHeartbeat && !acquiringChanged &&
      !(anomaly && now - this.lastReportAt >= this.cfg.minReportIntervalMs)) return;

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
      ...(acquiring ? { acquiring: true } : {}),
      ...(finished ? { finished: true } : {}),
    };
    this.tx(hb);
    this.stats.reportsSent++;
    this.lastReportAt = now;
    this.lastAcquiringSent = acquiring;
    if (dueHeartbeat) this.lastHbAt = now;
  }

  /**
   * Present on the room's media (or on the way to it) but not yet on its
   * timeline: gated, not judged. A creator or namer that has not adopted yet
   * is still acquiring too -- its player is where IT is, not where the room
   * was seeded, and judging it would seek it to the room's placeholder.
   */
  private acquiring(): boolean {
    return this.unacquired() && !this.d.isHidden();
  }

  /**
   * `acquiring()`, whether or not the tab is visible. A hidden tab in this
   * state is not on its way -- its media does not load until it is shown
   * (BROWSER-FINDINGS §5b) -- so it is reported absent rather than gated on.
   * It is still not on the room's timeline, though: judged, a hidden member at
   * readyState 0 gates every play, and a hidden seeder is corrected to the
   * room's placeholder and then seeds the room from there.
   */
  private unacquired(): boolean {
    if (!this.gating() || this.autoplayBlocked) return false;
    const a = this.acq;
    if (this.onRoomMedia()) {
      return (a.state === 'detached' && !a.pastEnd) || a.state === 'conforming' ||
        (a.state === 'guarded' && a.policy === 'adopt');
    }
    return this.inTransit && this.anchor.mediaKey !== '' && this.d.now() <= this.inTransitUntil;
  }

  /**
   * Whether a gesture accounts for what the player just did: an input within
   * `gestureWindowMs`, AND after this media epoch began. The second half is
   * what keeps the click on a "next episode" link from counting for that
   * episode's autoplay -- `isActive` is still true then (BROWSER-FINDINGS §20).
   */
  private intent(now: number): boolean {
    const g = this.d.gestures;
    if (!g) return true;
    const at = Math.max(g.lastInputAt(), this.activationEdgeAt);
    return at >= this.acq.startedAt && now - at <= this.cfg.gestureWindowMs;
  }

  /** A rise of `isActive` with no input behind it is a media key. */
  private sampleActivation(now: number): void {
    const g = this.d.gestures;
    if (!g) return;
    const act = g.activationActive() === true;
    if (act && !this.prevActivation &&
      now - Math.max(g.lastInputAt(), g.lastIgnoredInputAt()) > this.cfg.gestureWindowMs) {
      this.activationEdgeAt = now;
    }
    this.prevActivation = act;
  }

  /**
   * Decide whose change an observation is, and act on it.
   *
   * `steady` (or no gesture evidence): the member's, as always. Otherwise a
   * gesture makes it the member's and ends acquiring; with none, it is the
   * site's -- put back while `guarded`, left for the conform step before.
   */
  private classify(o: Observation, state: PlayerState, now: number): void {
    const a = this.acq;
    if (!this.gating() || a.state === 'steady') {
      this.act(o, state);
      return;
    }
    if (a.state === 'fought' && this.intent(now)) {
      // The panel asked for a press, so any press ends it -- including one
      // that agrees with the room, which the echo test below would swallow.
      this.stats.gesturedIntents++;
      const adopting = this.adoptFor !== null && this.adoptFor === this.anchor.mediaKey;
      this.toSteady(now, state);
      // A seeder the site fought: the adoption carries the press (below).
      if (!adopting) this.act(o, state);
      return;
    }
    if (this.isEcho(o, state)) {
      this.stats.echoesSuppressed++;
      return;
    }
    if (o.kind === 'playstate' && o.paused && state.ended) {
      // Nobody's pause, and not the site's to be undone either: a conform
      // would press play on an ended element, which starts it over.
      this.stats.endsNotSent++;
      return;
    }
    if (this.intent(now)) {
      this.stats.gesturedIntents++;
      const adopting = this.adoptFor !== null && this.adoptFor === this.anchor.mediaKey;
      this.toSteady(now, state);
      // A creator's press is carried by the adoption, which sends the
      // position as well; the press alone (a `play` has none) would not.
      if (!adopting) this.act(o, state);
      return;
    }
    if (a.state === 'guarded' && !this.applyingRemote && !this.conformInFlight) {
      this.stats.siteMovesAbsorbed++;
      if (++a.reconforms > this.cfg.maxReconforms) {
        // A seeder too: a site that never stops moving the player would keep
        // it guarded, and so acquiring, for good -- holding every play of the
        // room. Left alone, it is absent, and a press seeds from wherever the
        // member takes the player (`toSteady` still has `adoptFor`).
        this.stats.fought++;
        this.setAcq('fought');
        return;
      }
      if (a.policy === 'adopt') {
        // The site is setting up the member's own player, which the room is
        // about to be seeded from: let it, and wait for it to finish.
        a.guardedAt = now;
        return;
      }
      this.conform();
      return;
    }
    this.stats.ungesturedIgnored++;
  }

  /** The effect of our own in-flight transition, or agreement with the room. */
  private isEcho(o: Observation, state: PlayerState): boolean {
    const applying = this.applyingRemote;
    if (o.kind === 'seek') {
      return !!applying &&
        Math.abs(o.positionS * 1000 - landsAt(applying.targetMs, state.durationS)) <= this.seekThresholdMs;
    }
    if (o.kind === 'playstate') {
      return o.paused === this.anchor.paused || (!!applying && o.paused === applying.paused);
    }
    return true;
  }

  /** The member's own change: tell the room. */
  private act(o: Observation, state: PlayerState): void {
    // While a transition is in flight, what it does to the player is not the
    // user's: its seek lands near its own target (the room may have moved on
    // since, so the two-diff test alone is not enough there), and its pause
    // state is the one it was asked for. Anything else is still the user's.
    const applying = this.applyingRemote;
    if (o.kind === 'seek') {
      if (!applying ||
        Math.abs(o.positionS * 1000 - landsAt(applying.targetMs, state.durationS)) >
          this.seekThresholdMs) {
        this.send('seek', o.positionS * 1000);
      }
    } else if (o.kind === 'playstate') {
      if (o.paused !== this.anchor.paused &&
        (!applying || o.paused !== applying.paused)) {
        if (o.paused && state.ended) {
          // The end of the media pauses the element, and it is nobody's
          // pause: sent, the first member to finish stops the room at its own
          // end, a member 100 ms behind is stopped just short of `ended`, and
          // a site that moves on at `ended` never moves on for them.
          this.stats.endsNotSent++;
          return;
        }
        this.send(o.paused ? 'pause' : 'play', o.positionS * 1000);
        if (!o.paused) this.holdForRoom();
      } else {
        // Agrees with the anchor: this is our own applied transition coming
        // back around, not user intent. The pause/play counterpart of the
        // two-diff test's roomDiff, and the reason echo suppression here is
        // structural rather than a timeout flag.
        this.stats.echoesSuppressed++;
      }
    }
  }

  /**
   * Remember that this member's element reached the end of the room's media
   * (or is within `endWindowMs` of it while the room plays), for the next
   * episode. Forgotten when the same epoch turns out not to be finished --
   * a member who scrubbed back from the credits.
   */
  private trackFinish(now: number, state: PlayerState): void {
    if (!this.onRoomMedia()) return;
    const durMs = state.durationS * 1000;
    const near = durMs > 0 && !this.anchor.paused && !state.paused &&
      state.positionS * 1000 >= durMs - this.cfg.endWindowMs;
    if (state.ended || near) {
      // When it finished, not when it was last seen finished: the
      // continuation window runs from the end, not from the end screen.
      const f = this.lastFinish;
      if (f && f.epoch === this.acq.id && f.key === this.localMediaKey) return;
      this.lastFinish = { key: this.localMediaKey, epoch: this.acq.id, at: now };
    } else if (this.lastFinish && this.lastFinish.epoch === this.acq.id && durMs > 0) {
      this.lastFinish = null;
    }
  }

  /**
   * A room that names nothing is named by the first member on media, with the
   * condition "still nothing" (C3). That member then seeds the room from its
   * own player once its acquisition settles, as a creator does.
   */
  private nameRoomIfUnnamed(state: PlayerState): void {
    if (this.anchor.mediaKey !== '' || this.localMediaKey === '' || this.namedFor === this.localMediaKey) return;
    if (!this.clock.ready || this.d.isHidden() || state.readyState < 1 || !(state.durationS > 0)) return;
    this.namedFor = this.localMediaKey;
    this.adoptFor = this.localMediaKey;
    this.foreignMove = false;
    this.stats.namings++;
    this.send('media', state.positionS * 1000, { key: this.localMediaKey, url: this.localMediaUrl }, '');
  }

  /** DETACHED -> CONFORMING/GUARDED, and GUARDED -> STEADY. */
  private advanceAcquisition(now: number, state: PlayerState): void {
    if (!this.gating()) return;
    const a = this.acq;
    if (a.state === 'detached') {
      if (!this.readyToAcquire(now, state)) return;
      if (this.foreignMove) this.adoptFor = null;
      a.policy = this.adoptFor !== null && this.adoptFor === this.anchor.mediaKey ? 'adopt' : 'conform';
      this.stats.acquisitions++;
      if (a.policy === 'adopt') {
        a.guardedAt = now;
        this.setAcq('guarded');
        return;
      }
      this.setAcq('conforming');
      this.conform();
      return;
    }
    if (a.state !== 'guarded' || this.conformInFlight || !this.onRoomMedia() || !this.clock.ready) return;
    // A playing room and a player running with it: startup is over, and from
    // here a site's pause is indistinguishable from a member's but by gesture,
    // which is exactly what `steady` assumes.
    const together = a.policy === 'conform' && !this.anchor.paused && !state.paused &&
      state.readyState >= 3 &&
      Math.abs(state.positionS * 1000 - expectedAt(this.anchor, this.serverNow())) <= this.cfg.seekToleranceMs;
    if (together || now - a.guardedAt >= this.cfg.settleMs) this.toSteady(now, state);
  }

  /**
   * Whether the element can be put where the room is. HAVE_FUTURE_DATA
   * rather than metadata: a site that resumes from its history writes the
   * position repeatedly until then (Laftel, BROWSER-FINDINGS §20), and
   * `canplay` is also where measured autoplay happens. A paused element that
   * stays at metadata because it will not buffer on its own is conformed
   * after `METADATA_ONLY_MS`.
   */
  private readyToAcquire(now: number, state: PlayerState): boolean {
    if (!this.clock.ready || !this.onRoomMedia() || this.d.isHidden()) return false;
    if (state.readyState < 1 || !(state.durationS > 0)) return false;
    const a = this.acq;
    if (a.metadataAt === 0) a.metadataAt = now;
    if (state.readyState < 3 && now - a.metadataAt < METADATA_ONLY_MS) return false;
    const expected = expectedAt(this.anchor, this.serverNow());
    a.pastEnd = expected > state.durationS * 1000 + PAST_DURATION_SLACK_MS;
    return !a.pastEnd;
  }

  /**
   * Put the room's state onto the element, once, serialised with every other
   * player mutation. Leads to `guarded`; if something newer took over while it
   * waited, acquisition starts over from `detached` against the newest anchor.
   */
  private conform(): void {
    const id = this.acq.id;
    const sess = this.epoch;
    const seq = this.lastAppliedSeq;
    const current = (): boolean => this.canAim(sess) && this.acq.id === id && this.lastAppliedSeq === seq;
    this.conformInFlight = true;
    void this.serialise(async () => {
      let done = false;
      try {
        if (!current()) return;
        await this.applyTransition(
          expectedAt(this.anchor, this.serverNow()), this.anchor.paused, this.cfg.seekToleranceMs, current);
        done = current();
      } finally {
        if (this.acq.id === id) {
          this.conformInFlight = false;
          const a = this.acq;
          if (done) {
            a.guardedAt = this.d.now();
            if (a.state === 'conforming') this.setAcq('guarded');
            this.startContinuation();
          } else if (a.state === 'conforming') {
            this.setAcq('detached');
          }
        }
      }
    });
  }

  /** Our continuation is on the room and conformed: start everybody. */
  private startContinuation(): void {
    const c = this.continuing;
    if (!c) return;
    if (this.d.now() - c.at > CONTINUATION_START_MS) {
      // Never conformed in time: the command was refused (`rate_limited`
      // names no command) or lost. Starting the room now would be a play
      // nobody pressed, on a move somebody else made.
      this.continuing = null;
      return;
    }
    if (c.key !== this.anchor.mediaKey || !this.onRoomMedia()) return;
    this.continuing = null;
    if (c.play) this.send('play', this.d.adapter.readState().positionS * 1000);
  }

  /**
   * Acquisition is over. A member who seeds the room does it now, from the
   * state it settled on -- unless the room was moved by somebody else in the
   * meantime, in which case that choice stands and this member conforms.
   */
  private toSteady(now: number, state: PlayerState): void {
    const a = this.acq;
    const was = a.state;
    this.setAcq('steady');
    if (this.adoptFor === null || this.adoptFor !== this.anchor.mediaKey || !this.onRoomMedia() || !this.clock.ready) return;
    this.adoptFor = null;
    if (!this.foreignMove) {
      this.stats.adoptions++;
      this.adoptLocalState(state);
    } else if (was === 'guarded') {
      const epoch = this.epoch;
      const id = a.id;
      void this.serialise(async () => {
        if (!this.canAim(epoch) || id !== this.acq.id) return;
        await this.applyTransition(
          expectedAt(this.anchor, this.serverNow()), this.anchor.paused,
          this.cfg.seekToleranceMs, () => this.canAim(epoch) && id === this.acq.id);
      });
    }
    void now;
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
   *
   * Not while a seek of our own is still on its way back: the anchor here is
   * the one that seek is about to replace, and holding at it pulled the
   * picture back to where the room HAD been, then forward again when the ack
   * landed. That ack holds us instead (see `applyScheduled`).
   */
  private holdForRoom(): void {
    if (!this.holdsLocalPlay()) return;
    this.stats.playsHeld++;
    const epoch = this.epoch;
    const seq = this.lastAppliedSeq;
    void this.serialise(async () => {
      // The room has moved since -- normally our own play landing already.
      // The player is doing what the room says; leave it.
      if (!this.canAim(epoch) || this.lastAppliedSeq !== seq || !this.anchor.paused) return;
      if (this.ownPending('seek') || this.ownPending('media')) return;
      await this.applyTransition(
        expectedAt(this.anchor, this.serverNow()), true, HOLD_SEEK_TOLERANCE_MS,
        () => this.canAim(epoch) && this.lastAppliedSeq === seq);
    });
  }

  /** Whether a local play in this room is held for the room. See `holdLocalPlay`. */
  private holdsLocalPlay(): boolean {
    return this.cfg.holdLocalPlay && this.members.length >= 2;
  }

  /** Whether a command of ours of this kind is still on its way back. */
  private ownPending(kind: CmdKind): boolean {
    const now = this.d.now();
    return this.unacked.some((c) => c.kind === kind && now - c.at < OWN_ACK_WAIT_MS);
  }

  /**
   * Settle one of our own commands on its ack, and say whether a `play` of
   * ours sent after it is still on its way.
   *
   * The server applies and acks in order, so anything of ours older than this
   * that is still unanswered was dropped and is forgotten with it.
   */
  private ownAck(reqId: string): boolean {
    const now = this.d.now();
    const live = this.unacked.filter((c) => now - c.at < OWN_ACK_WAIT_MS);
    const i = live.findIndex((c) => c.reqId === reqId);
    this.unacked = i < 0 ? live : live.slice(i + 1);
    return i >= 0 && this.unacked.some((c) => c.kind === 'play');
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
   *
   * On a fresh `paused@0` room the seek's ack says paused. It is not applied
   * as a pause while the play is still coming (`beforeOwnPlay`): the creator
   * was playing, and pausing them only to press play again a moment later
   * spends a play() that the browser can refuse.
   */
  private adoptLocalState(s: PlayerState): void {
    this.seek(s.positionS);
    if (!s.paused) this.play();
  }

  private send(
    kind: CmdKind, positionMs: number, media?: { key: string; url?: string | undefined }, ifMediaKey?: string,
  ): string {
    const reqId = `${this.selfId || 'x'}-${++this.reqSeq}`;
    const now = this.d.now();
    this.unacked = this.unacked.filter((c) => now - c.at < OWN_ACK_WAIT_MS);
    this.unacked.push({ reqId, kind, at: now });
    this.tx({
      t: 'cmd', reqId, kind, positionMs: Math.round(positionMs),
      ...(media === undefined ? {} : { mediaKey: media.key }),
      ...(media?.url ? { mediaUrl: media.url } : {}),
      ...(ifMediaKey === undefined ? {} : { ifMediaKey }),
    });
    this.stats.cmdsSent++;
    return reqId;
  }

  /** Explicit user actions, for UI buttons. Local detection covers the rest. */
  play(): string { return this.send('play', this.d.adapter.readState().positionS * 1000); }
  pause(): string { return this.send('pause', this.d.adapter.readState().positionS * 1000); }
  seek(positionS: number): string { return this.send('seek', positionS * 1000); }
  /**
   * Point the room at other media. `mediaUrl` is where the others can open it.
   * `ifMediaKey`, when given, is the room media this was decided against: if
   * somebody moved the room first, the server refuses this one.
   */
  setMedia(mediaKey: string, positionMs = 0, mediaUrl?: string, ifMediaKey?: string): string {
    return this.send('media', positionMs, { key: mediaKey, url: mediaUrl }, ifMediaKey);
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
  /** Where this member is in acquiring its video. See `AcquisitionState`. */
  get acquisition(): AcquisitionState { return this.acq.state; }

  /**
   * Which optional pieces this engine was built with. Every one of them is
   * optional so that a test can leave it out -- and so a shim that forgets one
   * degrades silently: without gesture evidence all of D8 is off. `dump()`
   * reports this, and the app tests pin that the shared wiring supplies all.
   */
  get wiring(): { gestures: boolean; continues: boolean; ticket: boolean } {
    return { gestures: !!this.d.gestures, continues: !!this.d.continues, ticket: !!this.d.ticket };
  }

  /** Whether this member is still to seed the room from its own player (a creator or namer). */
  get seedsRoom(): boolean { return this.adoptFor !== null; }

  /** Where the room should be right now, or null before the clock settles. */
  expectedMs(): number | null {
    return this.clock.ready ? expectedAt(this.anchor, this.serverNow()) : null;
  }
}
