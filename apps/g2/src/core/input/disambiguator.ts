import type { Scheduler, TimerHandle } from "../scheduler";
import type { InputSource } from "./event-types";
import type { InputChannel } from "./normalize";

/**
 * How long a single-press candidate is held before it is emitted, so that a
 * double press (the system exit gesture) never produces a single press first.
 *
 * PROVISIONAL: the G2 firmware's double-press window and whether it reports a
 * CLICK before DOUBLE_CLICK are not documented. 400 ms is conservative relative to
 * common OS double-tap timeouts (300–500 ms). Measure it with HARDWARE_TEST_PLAN.md
 * test H3 and update this constant (foundation-owned).
 */
export const DEFAULT_CLICK_DISAMBIGUATION_MS = 400;

/** Candidates arriving this soon after a double press are dropped (trailing firmware events). */
export const DEFAULT_POST_DOUBLE_PRESS_SUPPRESS_MS = 600;

export interface ResolvedSinglePress {
  /** When the first raw event of this press arrived. Use this for countdown deadlines. */
  pressedAtMs: number;
  /** When disambiguation finished and the press was emitted. */
  resolvedAtMs: number;
  channel: InputChannel;
  source: InputSource;
  eventTypeOmitted: boolean;
  /** Extra raw candidates merged into this press (same press reported twice). */
  coalescedCount: number;
}

export interface ResolvedDoublePress {
  pressedAtMs: number;
  channel: InputChannel;
  source: InputSource;
  /** True when a pending single-press candidate was discarded because of this double press. */
  cancelledPendingPress: boolean;
}

export interface PressDisambiguatorOptions {
  scheduler: Scheduler;
  windowMs?: number;
  postDoublePressSuppressMs?: number;
  onSinglePress(press: ResolvedSinglePress): void;
  onDoublePress(press: ResolvedDoublePress): void;
}

interface Pending {
  pressedAtMs: number;
  channel: InputChannel;
  source: InputSource;
  eventTypeOmitted: boolean;
  coalescedCount: number;
  timer: TimerHandle | null;
}

/**
 * Turns raw press candidates and double presses into clean single/double presses.
 *
 * Rules (each covered by disambiguator.test.ts):
 * - A candidate is held for `windowMs`; if no double press arrives it is emitted once.
 * - A double press cancels any held candidate: the exit gesture never triggers SOS.
 * - Further candidates while one is held are the same physical press (the host can
 *   report one press on both textEvent and sysEvent) and are merged, not emitted.
 * - Candidates within `postDoublePressSuppressMs` after a double press are dropped.
 * - `windowMs = 0` disables holding (only safe if hardware never sends CLICK before DOUBLE_CLICK).
 */
export class PressDisambiguator {
  private pending: Pending | null = null;
  private suppressUntil = -Infinity;
  private readonly windowMs: number;
  private readonly suppressMs: number;
  /** Counters for diagnostics and hardware testing. */
  readonly stats = {
    emittedSingle: 0,
    emittedDouble: 0,
    coalesced: 0,
    suppressed: 0,
    cancelled: 0,
  };

  constructor(private readonly options: PressDisambiguatorOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_CLICK_DISAMBIGUATION_MS;
    this.suppressMs = options.postDoublePressSuppressMs ?? DEFAULT_POST_DOUBLE_PRESS_SUPPRESS_MS;
  }

  hasPendingPress(): boolean {
    return this.pending !== null;
  }

  pressCandidate(candidate: {
    channel: InputChannel;
    source: InputSource;
    eventTypeOmitted: boolean;
  }) {
    const now = this.options.scheduler.now();
    if (now < this.suppressUntil) {
      this.stats.suppressed++;
      return;
    }
    if (this.pending) {
      this.pending.coalescedCount++;
      this.stats.coalesced++;
      if (this.pending.source === "unknown") this.pending.source = candidate.source;
      return;
    }
    const pending: Pending = { pressedAtMs: now, ...candidate, coalescedCount: 0, timer: null };
    this.pending = pending;
    if (this.windowMs <= 0) {
      this.resolve();
      return;
    }
    pending.timer = this.options.scheduler.setTimeout(() => this.resolve(), this.windowMs);
  }

  doublePress(press: { channel: InputChannel; source: InputSource }) {
    const now = this.options.scheduler.now();
    const cancelledPendingPress = this.clearPending();
    if (cancelledPendingPress) this.stats.cancelled++;
    this.suppressUntil = now + this.suppressMs;
    this.stats.emittedDouble++;
    this.options.onDoublePress({ pressedAtMs: now, ...press, cancelledPendingPress });
  }

  /** Drop a held candidate without emitting it (e.g. the app is leaving the foreground). */
  cancelPending(): boolean {
    const cancelled = this.clearPending();
    if (cancelled) this.stats.cancelled++;
    return cancelled;
  }

  dispose() {
    this.clearPending();
  }

  private clearPending(): boolean {
    if (!this.pending) return false;
    if (this.pending.timer !== null) this.options.scheduler.clearTimeout(this.pending.timer);
    this.pending = null;
    return true;
  }

  private resolve() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.stats.emittedSingle++;
    this.options.onSinglePress({
      pressedAtMs: pending.pressedAtMs,
      resolvedAtMs: this.options.scheduler.now(),
      channel: pending.channel,
      source: pending.source,
      eventTypeOmitted: pending.eventTypeOmitted,
      coalescedCount: pending.coalescedCount,
    });
  }
}
