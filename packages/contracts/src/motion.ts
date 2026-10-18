import { z } from "zod";
import { TimestampMsSchema } from "./common";

/**
 * One G2 IMU sample as delivered by the Even Hub SDK (`sysEvent.imuData` with
 * `eventType === IMU_DATA_REPORT`). The SDK documents x/y/z as floats but does
 * NOT document their units or axis orientation, so Haven treats them as raw
 * SDK units until they are characterized on hardware (docs/HARDWARE_TEST_PLAN.md).
 */
export const MotionSampleSchema = z.object({
  timestampMs: TimestampMsSchema,
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type MotionSample = z.infer<typeof MotionSampleSchema>;

/** How far back the motion summary attached to an SOS looks. */
export const MOTION_SUMMARY_WINDOW_MS = 60_000;
export const MAX_MOTION_OBSERVATIONS = 20;
export const MAX_MOTION_QUALITY_NOTES = 10;

export const MotionObservationKindSchema = z.enum([
  /** A single large change between consecutive samples. */
  "abrupt_change",
  /** Elevated movement sustained over several seconds. */
  "sustained_high_motion",
  /** Movement followed by an unusually still period. */
  "stillness_after_motion",
  /** Movement pattern that does not fit the wearer's recent baseline. */
  "irregular_motion",
  /** Samples stopped arriving (Bluetooth drop, WebView suspension, sensor off). */
  "sensor_gap",
]);
export type MotionObservationKind = z.infer<typeof MotionObservationKindSchema>;

/**
 * A factual, measurable observation. `detail` must describe what the numbers show
 * ("magnitude jumped 4.1x baseline within 120 ms"), never an interpretation
 * ("the wearer fell").
 */
export const MotionObservationSchema = z.object({
  kind: MotionObservationKindSchema,
  atMs: TimestampMsSchema,
  durationMs: z.number().int().nonnegative().optional(),
  magnitude: z.number().nonnegative().optional(),
  detail: z.string().min(1).max(200),
});
export type MotionObservation = z.infer<typeof MotionObservationSchema>;

const RangeStatsSchema = z
  .object({
    mean: z.number(),
    min: z.number(),
    max: z.number(),
    stdDev: z.number().nonnegative(),
  })
  .refine((s) => s.min <= s.max, { error: "min must be <= max" });

export const MotionStatisticsSchema = z.object({
  /** Vector magnitude sqrt(x² + y² + z²) per sample, in raw SDK units. */
  magnitude: RangeStatsSchema,
  /** Largest vector distance between two consecutive samples. */
  maxSampleDelta: z.number().nonnegative(),
  /** max − min per axis over the window. */
  axisRange: z.object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    z: z.number().nonnegative(),
  }),
});
export type MotionStatistics = z.infer<typeof MotionStatisticsSchema>;

export const MotionQualityLevelSchema = z.enum(["none", "poor", "fair", "good"]);
export type MotionQualityLevel = z.infer<typeof MotionQualityLevelSchema>;

export const MotionQualitySchema = z.object({
  level: MotionQualityLevelSchema,
  /** Samples per second actually observed; null when fewer than two samples. */
  effectiveSampleRateHz: z.number().nonnegative().nullable(),
  /** Longest interval without samples inside the window; null when fewer than two samples. */
  longestGapMs: z.number().int().nonnegative().nullable(),
  notes: z.array(z.string().min(1).max(200)).max(MAX_MOTION_QUALITY_NOTES),
});
export type MotionQuality = z.infer<typeof MotionQualitySchema>;

/**
 * Compact, privacy-preserving summary of recent head motion. Raw samples stay on the
 * phone; only this summary is sent with an SOS.
 */
export const MotionSummarySchema = z
  .object({
    windowStartMs: TimestampMsSchema,
    windowEndMs: TimestampMsSchema,
    sampleCount: z.number().int().nonnegative(),
    units: z.literal("sdk_raw"),
    /** Null when sampleCount is 0. */
    statistics: MotionStatisticsSchema.nullable(),
    observations: z.array(MotionObservationSchema).max(MAX_MOTION_OBSERVATIONS),
    quality: MotionQualitySchema,
  })
  .refine((s) => s.windowEndMs >= s.windowStartMs, {
    error: "windowEndMs must be >= windowStartMs",
  })
  .refine((s) => (s.sampleCount === 0) === (s.statistics === null), {
    error: "statistics must be null exactly when sampleCount is 0",
  });
export type MotionSummary = z.infer<typeof MotionSummarySchema>;
