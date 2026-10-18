import { z } from "zod";
import { TimestampMsSchema } from "./common";
import { LocationFixSchema } from "./location";
import { MotionSummarySchema } from "./motion";

/** The only model Haven may use for emergency context analysis. */
export const HAVEN_LLM_MODEL = "gemini-2.5-flash-lite";

/** Upper bound for the whole analysis call. The SOS never waits for it. */
export const CONTEXT_ANALYSIS_TIMEOUT_MS = 10_000;

/**
 * Sensor data captured on the phone at SOS time. `HavenDeviceService.getEmergencySnapshot()`
 * produces it on the G2 side; the backend passes the same shape to the context service.
 */
export const EmergencySensorSnapshotSchema = z.object({
  capturedAtMs: TimestampMsSchema,
  location: LocationFixSchema.nullable(),
  motionSummary: MotionSummarySchema.nullable(),
  /** Short factual notes about collection problems, e.g. "location permission denied". */
  diagnostics: z.array(z.string().min(1).max(200)).max(10),
});
export type EmergencySensorSnapshot = z.infer<typeof EmergencySensorSnapshotSchema>;

export const EvidenceQualitySchema = z.enum(["insufficient", "limited", "adequate"]);
export type EvidenceQuality = z.infer<typeof EvidenceQualitySchema>;

export const UncertaintySchema = z.enum(["low", "medium", "high"]);
export type Uncertainty = z.infer<typeof UncertaintySchema>;

/**
 * Structured LLM output (validated server-side before use). Rules for producers:
 * - Describe only what the sensor data supports. Never invent incidents, injuries,
 *   attackers, vehicles, or the wearer's intent.
 * - Use null / empty arrays rather than guessing.
 * - `evidenceQuality: "insufficient"` means the follow-up message should say so plainly.
 */
export const ContextResultSchema = z.object({
  /** e.g. "Near the intersection of Westwood Blvd and Le Conte Ave (approximate)". */
  locationDescription: z.string().min(1).max(280).nullable(),
  /** Factual motion statements, e.g. "Abrupt head movement about 40 s before the alert". */
  motionObservations: z.array(z.string().min(1).max(200)).max(5),
  /** Hedged possibilities, e.g. "Movement pattern is consistent with a sudden stop". */
  possibleContext: z.string().min(1).max(400).nullable(),
  uncertainty: UncertaintySchema,
  evidenceQuality: EvidenceQualitySchema,
  model: z.string().min(1).max(100),
  generatedAt: TimestampMsSchema,
});
export type ContextResult = z.infer<typeof ContextResultSchema>;

export const ContextFailureReasonSchema = z.enum([
  "timeout",
  "provider_error",
  "invalid_output",
  "not_configured",
]);
export type ContextFailureReason = z.infer<typeof ContextFailureReasonSchema>;

/** What `HavenContextService.analyzeEmergencyContext` resolves with. It never rejects. */
export const ContextAnalysisOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), result: ContextResultSchema }),
  z.object({ status: z.literal("insufficient_information"), result: ContextResultSchema }),
  z.object({
    status: z.literal("failed"),
    reason: ContextFailureReasonSchema,
    detail: z.string().max(500).optional(),
  }),
]);
export type ContextAnalysisOutcome = z.infer<typeof ContextAnalysisOutcomeSchema>;
