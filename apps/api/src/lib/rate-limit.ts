import type { Clock } from "./clock";

/** In-memory fixed-window limiter. Adequate for a single-instance hackathon backend. */
export interface RateLimiter {
  /** Records one attempt and returns false when `key` is over its limit. */
  attempt(key: string): boolean;
  reset(key: string): void;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  clock: Clock;
}): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    attempt(key) {
      const now = options.clock.now();
      const current = windows.get(key);
      if (!current || now - current.start >= options.windowMs) {
        windows.set(key, { start: now, count: 1 });
        if (windows.size > 10_000) windows.clear();
        return true;
      }
      current.count++;
      return current.count <= options.limit;
    },
    reset(key) {
      windows.delete(key);
    },
  };
}
