// Owner: Agent 3. Deterministic head-motion summary from raw G2 IMU samples.
//
// The SDK does not document IMU units or axis orientation, so every threshold here is
// RELATIVE to the window's own data (multiples of the typical sample-to-sample change),
// never an absolute physical value. Observations describe what the numbers show; they never
// claim a fall, collision, assault, or medical event.
import {
  MAX_MOTION_OBSERVATIONS,
  MAX_MOTION_QUALITY_NOTES,
  MOTION_SUMMARY_WINDOW_MS,
  type MotionObservation,
  type MotionQualityLevel,
  type MotionSample,
  type MotionSummary,
} from "@haven/contracts";

/** Hard cap on buffered samples (100 Hz for 60 s), so memory stays bounded at any pace. */
export const MAX_BUFFERED_SAMPLES = 6_000;
/** Raw values beyond this are treated as corrupt rather than real motion. */
export const MAX_ABS_AXIS_VALUE = 1e6;
/** A pause between samples at least this long is reported as a sensor gap. */
export const SENSOR_GAP_MS = 2_000;

const ABRUPT_FACTOR = 6;
const ACTIVE_FACTOR = 3;
const STILL_FACTOR = 1.5;
const MIN_SAMPLES_FOR_PATTERNS = 10;
const SUSTAINED_MIN_MS = 3_000;
const STILLNESS_MIN_MS = 5_000;
const MERGE_WINDOW_MS = 1_000;

/** Bounded rolling buffer of IMU samples. Drops invalid values and anything older than the window. */
export class MotionBuffer {
  private samples: MotionSample[] = [];
  private invalid = 0;
  private truncated = false;

  constructor(
    private readonly windowMs = MOTION_SUMMARY_WINDOW_MS,
    private readonly maxSamples = MAX_BUFFERED_SAMPLES,
  ) {}

  /** Returns false when the sample was rejected as invalid. */
  add(timestampMs: number, x: unknown, y: unknown, z: unknown): boolean {
    if (!isValidAxis(x) || !isValidAxis(y) || !isValidAxis(z) || !Number.isFinite(timestampMs)) {
      this.invalid++;
      return false;
    }
    const last = this.samples[this.samples.length - 1];
    // Timestamps come from the WebView clock; keep them non-decreasing.
    const t = Math.max(Math.floor(timestampMs), last ? last.timestampMs : 0);
    this.samples.push({ timestampMs: t, x, y, z });
    this.prune(t);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
      this.truncated = true;
    }
    return true;
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.timestampMs < cutoff) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }

  snapshot(): { samples: MotionSample[]; invalidCount: number; truncated: boolean } {
    return { samples: [...this.samples], invalidCount: this.invalid, truncated: this.truncated };
  }

  clear(): void {
    this.samples = [];
    this.invalid = 0;
    this.truncated = false;
  }

  get size(): number {
    return this.samples.length;
  }
}

function isValidAxis(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_ABS_AXIS_VALUE
  );
}

const round = (value: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stats(values: number[]) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return { mean, min, max, stdDev: Math.sqrt(sq / values.length) };
}

const clip = (text: string) => (text.length <= 200 ? text : `${text.slice(0, 197)}...`);
const seconds = (ms: number) => `${round(ms / 1000, 1)} s`;

/**
 * Summarize the samples inside [nowMs - window, nowMs]. Pure and deterministic: the same
 * inputs always give the same summary. Always returns a value that satisfies MotionSummarySchema.
 */
export function summarizeMotion(
  input: { samples: MotionSample[]; invalidCount?: number; truncated?: boolean },
  nowMs: number,
  windowMs = MOTION_SUMMARY_WINDOW_MS,
): MotionSummary {
  const windowEndMs = Math.max(0, Math.floor(nowMs));
  const windowStartMs = Math.max(0, windowEndMs - windowMs);
  const samples = input.samples.filter(
    (s) => s.timestampMs >= windowStartMs && s.timestampMs <= windowEndMs,
  );
  const notes: string[] = ["Values are raw, uncalibrated SDK units"];
  if (input.invalidCount) notes.push(`${input.invalidCount} invalid IMU readings were discarded`);
  if (input.truncated) notes.push("Sample buffer hit its size limit; oldest samples were dropped");

  if (samples.length === 0) {
    notes.push("No IMU samples received in the window");
    return {
      windowStartMs,
      windowEndMs,
      sampleCount: 0,
      units: "sdk_raw",
      statistics: null,
      observations: [],
      quality: {
        level: "none",
        effectiveSampleRateHz: null,
        longestGapMs: null,
        notes: notes.slice(0, MAX_MOTION_QUALITY_NOTES),
      },
    };
  }

  const magnitudes = samples.map((s) => Math.hypot(s.x, s.y, s.z));
  const deltas: number[] = [];
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    deltas.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    intervals.push(b.timestampMs - a.timestampMs);
  }
  const axis = (pick: (s: MotionSample) => number) => {
    const values = samples.map(pick);
    return round(Math.max(...values) - Math.min(...values));
  };
  const mag = stats(magnitudes);
  const statistics = {
    magnitude: {
      mean: round(mag.mean),
      min: round(mag.min),
      max: round(mag.max),
      stdDev: round(mag.stdDev),
    },
    maxSampleDelta: round(deltas.length ? Math.max(...deltas) : 0),
    axisRange: { x: axis((s) => s.x), y: axis((s) => s.y), z: axis((s) => s.z) },
  };

  // ── Quality ──
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const spanMs = last.timestampMs - first.timestampMs;
  const tailGapMs = windowEndMs - last.timestampMs;
  const innerGapMs = intervals.length ? Math.max(...intervals) : 0;
  const longestGapMs = samples.length < 2 ? null : Math.round(Math.max(innerGapMs, tailGapMs));
  const effectiveSampleRateHz =
    samples.length < 2 || spanMs <= 0 ? null : round((samples.length - 1) / (spanMs / 1000), 2);
  let level: MotionQualityLevel;
  if (samples.length < 2) level = "poor";
  else if (
    samples.length >= 20 &&
    (longestGapMs ?? Infinity) <= SENSOR_GAP_MS &&
    spanMs >= windowMs / 2
  )
    level = "good";
  else if (samples.length >= 5 && (longestGapMs ?? Infinity) <= 10_000) level = "fair";
  else level = "poor";
  if (intervals.length >= 5) {
    const iv = stats(intervals);
    if (iv.mean > 0 && iv.stdDev / iv.mean > 1) notes.push("Sampling intervals were irregular");
  }
  if (spanMs < windowMs / 2) notes.push(`Samples cover only ${seconds(spanMs)} of the window`);

  // ── Observations (relative thresholds only) ──
  const observations: MotionObservation[] = [];
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i]! >= SENSOR_GAP_MS) {
      observations.push({
        kind: "sensor_gap",
        atMs: samples[i]!.timestampMs,
        durationMs: Math.round(intervals[i]!),
        detail: `No IMU samples for ${seconds(intervals[i]!)}`,
      });
    }
  }
  if (tailGapMs >= SENSOR_GAP_MS) {
    observations.push({
      kind: "sensor_gap",
      atMs: last.timestampMs,
      durationMs: Math.round(tailGapMs),
      detail: `No IMU samples in the last ${seconds(tailGapMs)} before the snapshot`,
    });
  }

  if (samples.length >= MIN_SAMPLES_FOR_PATTERNS) {
    const typical = median(deltas);
    const floor = Math.max(1e-6, 0.15 * median(magnitudes));
    const abruptThreshold = Math.max(ABRUPT_FACTOR * typical, floor);
    const activeThreshold = Math.max(ACTIVE_FACTOR * typical, floor / 3);
    const stillThreshold = Math.max(STILL_FACTOR * typical, 1e-9);
    let lastMotionEndMs: number | null = null;

    // Abrupt changes, merged when they cluster within MERGE_WINDOW_MS.
    let lastAbruptAt = -Infinity;
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i]!;
      if (d <= abruptThreshold || (typical === 0 && d <= floor)) continue;
      const at = samples[i + 1]!.timestampMs;
      const ratio = typical > 0 ? `${round(d / typical, 1)}x the typical change` : "a large change";
      const prev = observations[observations.length - 1];
      if (prev && prev.kind === "abrupt_change" && at - lastAbruptAt <= MERGE_WINDOW_MS) {
        if ((prev.magnitude ?? 0) < d) {
          prev.magnitude = round(d);
          prev.detail = clip(`Change between consecutive samples reached ${ratio}`);
        }
      } else {
        observations.push({
          kind: "abrupt_change",
          atMs: at,
          magnitude: round(d),
          detail: clip(`Change between consecutive samples reached ${ratio}`),
        });
      }
      lastAbruptAt = at;
      lastMotionEndMs = at;
    }

    // Sustained elevated movement: runs of active samples allowing brief (<500 ms) lulls.
    let runStart: number | null = null;
    let runEnd = 0;
    let lull = 0;
    const flush = () => {
      if (runStart !== null && runEnd - runStart >= SUSTAINED_MIN_MS) {
        observations.push({
          kind: "sustained_high_motion",
          atMs: runStart,
          durationMs: Math.round(runEnd - runStart),
          detail: clip(`Elevated head movement for ${seconds(runEnd - runStart)}`),
        });
        lastMotionEndMs = Math.max(lastMotionEndMs ?? 0, runEnd);
      }
      runStart = null;
      lull = 0;
    };
    for (let i = 0; i < deltas.length; i++) {
      const at = samples[i + 1]!.timestampMs;
      if (deltas[i]! > activeThreshold) {
        if (runStart === null) runStart = samples[i]!.timestampMs;
        runEnd = at;
        lull = 0;
      } else if (runStart !== null) {
        lull += intervals[i]!;
        if (lull >= 500) flush();
      }
    }
    flush();

    // Stillness after the most recent movement.
    if (lastMotionEndMs !== null) {
      const motionEnd: number = lastMotionEndMs;
      let stillStart: number | null = null;
      let stillEnd = 0;
      for (let i = 0; i < deltas.length; i++) {
        const at = samples[i + 1]!.timestampMs;
        if (at <= motionEnd) continue;
        if (deltas[i]! <= stillThreshold) {
          if (stillStart === null) stillStart = samples[i]!.timestampMs;
          stillEnd = at;
        } else {
          stillStart = null;
        }
      }
      if (
        stillStart !== null &&
        stillStart - motionEnd <= 3_000 &&
        stillEnd - stillStart >= STILLNESS_MIN_MS
      ) {
        observations.push({
          kind: "stillness_after_motion",
          atMs: stillStart,
          durationMs: Math.round(stillEnd - stillStart),
          detail: clip(`Little head movement for ${seconds(stillEnd - stillStart)} after movement`),
        });
      }
    }

    // Recent movement that departs from the earlier part of the window.
    if (spanMs >= 30_000) {
      const splitAt = last.timestampMs - 10_000;
      const earlier = magnitudes.filter((_, i) => samples[i]!.timestampMs < splitAt);
      const recent = magnitudes.filter((_, i) => samples[i]!.timestampMs >= splitAt);
      if (earlier.length >= 5 && recent.length >= 5) {
        const e = stats(earlier).stdDev;
        const r = stats(recent).stdDev;
        if (e > 0 && r > 3 * e) {
          observations.push({
            kind: "irregular_motion",
            atMs: splitAt,
            durationMs: 10_000,
            detail: clip(
              `Movement variability in the last 10 s was ${round(r / e, 1)}x the earlier baseline`,
            ),
          });
        }
      }
    }
  }

  observations.sort((a, b) => a.atMs - b.atMs);
  return {
    windowStartMs,
    windowEndMs,
    sampleCount: samples.length,
    units: "sdk_raw",
    statistics,
    observations: observations.slice(-MAX_MOTION_OBSERVATIONS),
    quality: {
      level,
      effectiveSampleRateHz,
      longestGapMs,
      notes: notes.map(clip).slice(0, MAX_MOTION_QUALITY_NOTES),
    },
  };
}
