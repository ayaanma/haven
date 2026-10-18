/**
 * Injectable time source and timers. Input disambiguation and the SOS countdown use it
 * so tests can drive time deterministically (see src/testing/manual-scheduler.ts).
 *
 * Countdown code must compare `now()` against an absolute deadline rather than count
 * timer ticks: WebView timers can be delayed or coalesced, and SDK versions before
 * 0.0.16 could fire setTimeout/setInterval callbacks more than once.
 */
export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Opaque handle returned by `setTimeout`; pass it back to `clearTimeout` only. */
export type TimerHandle = unknown;

export const browserScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
