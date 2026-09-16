/**
 * The wire protocol, mirroring `server/internal/room/messages.go` field for
 * field. See `docs/PROTOCOL.md`.
 *
 * These are the only types allowed to know about JSON. Everything else in the
 * client works on the engine's own state.
 */
import type { Anchor } from './clock.ts';

/** Room state as the server publishes it. Identical to `vsync.Anchor`. */
export type WireAnchor = Anchor;

export interface MemberInfo {
  readonly id: string;
  readonly name: string;
  readonly suspended: boolean;
  readonly ready: boolean;
}

// --- client -> server -------------------------------------------------------

export interface HelloFrame {
  t: 'hello';
  room: string;
  secret: string;
  name: string;
  mediaKey: string;
  /** Only the first member's is kept -- see `mediaKey`. */
  mediaUrl?: string;
  /** A server-access ticket, when the server gates joining. Single-use. */
  ticket?: string;
}

export interface TimeFrame {
  t: 'time';
  /** Our clock when we sent it. Echoed back untouched. */
  t0: number;
}

export type CmdKind = 'play' | 'pause' | 'seek' | 'media';

export interface CmdFrame {
  t: 'cmd';
  reqId: string;
  kind: CmdKind;
  positionMs: number;
  mediaKey?: string;
  mediaUrl?: string;
  /**
   * `media` only: apply only while the room is on exactly this key, else the
   * server answers `error{code:"media_stale"}` and takes no seq. `""` names a
   * room that names nothing yet.
   */
  ifMediaKey?: string;
}

/**
 * The heartbeat. **Every field is load-bearing** -- `docs/PROTOCOL.md` §4 lists
 * what silently stops working for each one omitted, and "silently" is the
 * operative word: a missing `uncertaintyMs` does not error, it just collapses
 * the server's dead-band onto TOLERANCE and reintroduces the failure where
 * three perfectly aligned clients were pushed 1.2 s apart by the corrections.
 */
export interface HbFrame {
  t: 'hb';
  residualMs: number;
  slopeMsPerS: number;
  positionMs: number;
  paused: boolean;
  readyState: number;
  bufferedAheadS: number;
  bufferedBehindS: number;
  lastAppliedSeq: number;
  atServerMs: number;
  uncertaintyMs: number;
  rttMs: number;
  clockSamples: number;
  suspended: boolean;
  /** On its way to the room's media: present, not ready (PROTOCOL §4 amendment). */
  acquiring?: boolean;
  /** The element reached its end. Sent with `suspended: true`. */
  finished?: boolean;
}

export interface ChatInFrame { t: 'chat'; text: string }
export interface RotateFrame { t: 'rotate' }

export type ClientFrame =
  | HelloFrame | TimeFrame | CmdFrame | HbFrame | ChatInFrame | RotateFrame;

// --- server -> client -------------------------------------------------------

export interface WelcomeFrame {
  t: 'welcome';
  you: string;
  seq: number;
  anchor: WireAnchor;
  members: MemberInfo[];
  serverMs: number;
  mediaKey: string;
}

export interface TimeReplyFrame {
  t: 'time.reply';
  t0: number;
  tRecv: number;
  tSend: number;
}

export interface StateFrame {
  t: 'state';
  seq: number;
  when: number;
  emittedAt: number;
  anchor: WireAnchor;
  by: string;
  kind: string;
}

/**
 * The originator's copy of a StateFrame. It carries `when` and **must be
 * scheduled against exactly like a StateFrame** -- excluding the sender from
 * the broadcast for echo suppression must not exclude it from the simultaneity
 * the timebase exists to provide. Measured cost of getting this wrong:
 * command-storm mean divergence 4743 ms -> 32 ms (POC-FINDINGS §20).
 */
export interface AckFrame {
  t: 'ack';
  reqId: string;
  seq: number;
  anchor: WireAnchor;
  when: number;
  emittedAt: number;
  kind: string;
}

export interface CorrectFrame {
  t: 'correct';
  mode: 'seek' | 'nudge';
  rate?: number;
  when: number;
  why?: string;
  // Deliberately carries no target position: one computed at send time is
  // stale by a downlink delay on arrival. Re-derive from the anchor.
}

export interface GateFrame {
  t: 'gate';
  /** A command is actually being held. */
  waiting: boolean;
  /** Who is not ready. Non-empty without `waiting` just means "show a spinner". */
  waitingOn?: string[];
  reason?: string;
}

export interface MembersFrame {
  t: 'members';
  members: MemberInfo[];
  joined?: string;
  left?: string;
}

export interface ChatOutFrame {
  t: 'chat';
  from: string;
  name: string;
  text: string;
  serverMs: number;
}

export interface MediaMismatchFrame {
  t: 'media.mismatch';
  roomMediaKey: string;
  yours: string;
}

export interface SecretFrame { t: 'secret'; secret: string; rotated: string }

export type ErrorCode =
  | 'join_refused' | 'room_full' | 'already_joined' | 'auth_required'
  | 'bad_frame' | 'bad_kind' | 'bad_cmd' | 'rate_limited'
  /** A conditional `media` command whose condition no longer held (PROTOCOL §3). */
  | 'media_stale';

export interface ErrorFrame { t: 'error'; code: ErrorCode | string; msg?: string }

export type ServerFrame =
  | WelcomeFrame | TimeReplyFrame | StateFrame | AckFrame | CorrectFrame
  | GateFrame | MembersFrame | ChatOutFrame | MediaMismatchFrame | SecretFrame
  | ErrorFrame;

/**
 * Narrowing guard. A frame type we do not know is not an error: the server may
 * be newer than we are, and dropping the connection over it would make every
 * deploy a breaking change.
 */
export function isServerFrame(v: unknown): v is ServerFrame {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}
