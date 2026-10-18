/** Injectable time source so tests control "now". */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
