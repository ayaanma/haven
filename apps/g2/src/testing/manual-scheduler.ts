import type { Scheduler, TimerHandle } from "../core/scheduler";

/** Deterministic scheduler: time moves only when a test calls advance(). */
export class ManualScheduler implements Scheduler {
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  constructor(private current = 1_000_000) {}

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Advance time, firing due timers in order (timers scheduled while firing are honored). */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.current = timer.at;
      timer.callback();
    }
    this.current = target;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
