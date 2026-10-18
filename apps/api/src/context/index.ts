// Owner: Agent 3. AI emergency context (Gemini 2.5 Flash-Lite via the OpenAI-compatible API).
//
// Safety design:
// - The SOS never waits for this. analyzeEmergencyContext never rejects; every failure resolves
//   as `failed`, and thin evidence resolves as `insufficient_information`.
// - The model never sees raw coordinates (it has no map data, so it could only guess place
//   names). locationDescription is built deterministically from fix accuracy and age.
// - Evidence quality is capped by a deterministic assessment, and uncertainty is never "low":
//   IMU units are raw and uncalibrated.
// - Output is validated with Zod; statements that claim incidents, injuries, or intent are dropped.
import {
  CONTEXT_ANALYSIS_TIMEOUT_MS,
  ContextResultSchema,
  EmergencySensorSnapshotSchema,
  EvidenceQualitySchema,
  LOCATION_STALE_AFTER_MS,
  UncertaintySchema,
  locationAgeMs,
  type AlertRecord,
  type ContextAnalysisOutcome,
  type ContextResult,
  type EmergencySensorSnapshot,
  type EvidenceQuality,
  type Uncertainty,
} from "@haven/contracts";
import { z } from "zod";
import type { HavenContextService, ServiceContext } from "../lib/interfaces";

/** Location fixes less accurate than this are not treated as usable evidence. */
export const USABLE_ACCURACY_METERS = 100;

export interface LiveContextOptions {
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createContextService(ctx: ServiceContext): HavenContextService {
  if (ctx.config.llm.mode === "mock") return createMockContextService(ctx);
  return createLiveContextService(ctx);
}

/**
 * LLM_MODE=mock: makes no network calls and makes no claims. It always reports
 * insufficient information, so demos never show fabricated context.
 */
export function createMockContextService(ctx: ServiceContext): HavenContextService {
  return {
    async analyzeEmergencyContext() {
      const result: ContextResult = {
        locationDescription: null,
        motionObservations: [],
        possibleContext: null,
        uncertainty: "high",
        evidenceQuality: "insufficient",
        model: `mock:${ctx.config.llm.model}`,
        generatedAt: ctx.clock.now(),
      };
      return { status: "insufficient_information", result };
    },
  };
}

// ── Deterministic evidence assessment ─────────────────────────────────────────

export interface EvidenceAssessment {
  quality: EvidenceQuality;
  /** Minimum uncertainty the output may report. */
  uncertaintyFloor: Uncertainty;
  locationUsable: boolean;
  motionUsable: boolean;
  locationDescription: string | null;
  motionObservations: string[];
}

export function assessEvidence(
  alert: AlertRecord,
  snapshot: EmergencySensorSnapshot,
): EvidenceAssessment {
  const loc = snapshot.location;
  const ageMs = loc ? locationAgeMs(loc, alert.activatedAt) : null;
  const locationUsable =
    !!loc &&
    ageMs !== null &&
    ageMs <= LOCATION_STALE_AFTER_MS &&
    (loc.accuracyMeters === null || loc.accuracyMeters <= USABLE_ACCURACY_METERS);
  const motion = snapshot.motionSummary;
  const motionUsable =
    !!motion && (motion.quality.level === "fair" || motion.quality.level === "good");

  let quality: EvidenceQuality = "insufficient";
  if (locationUsable && motionUsable && motion?.quality.level === "good") quality = "adequate";
  else if (locationUsable || motionUsable) quality = "limited";

  return {
    quality,
    uncertaintyFloor: quality === "adequate" ? "medium" : "high",
    locationUsable,
    motionUsable,
    locationDescription: describeLocation(snapshot, alert.activatedAt),
    motionObservations:
      motionUsable && motion ? motion.observations.map((o) => o.detail).slice(-5) : [],
  };
}

function describeLocation(snapshot: EmergencySensorSnapshot, activatedAt: number): string | null {
  const loc = snapshot.location;
  if (!loc) return null;
  const ageS = Math.round(locationAgeMs(loc, activatedAt) / 1000);
  const age = ageS < 120 ? `${ageS} s` : `${Math.round(ageS / 60)} min`;
  const accuracy =
    loc.accuracyMeters === null
      ? "accuracy not reported"
      : `accurate to about ${Math.round(loc.accuracyMeters)} m`;
  const timing =
    loc.timestampSource === "host" ? `${age} before the alert` : `received ${age} before the alert`;
  const stale =
    ageS * 1000 > LOCATION_STALE_AFTER_MS ? "Last known phone location" : "Phone GPS location";
  return `${stale}, ${accuracy}, from ${timing}`.slice(0, 280);
}

// ── Grounding guard ───────────────────────────────────────────────────────────

/**
 * Words that assert an incident, injury, attacker, or intent. The prompt forbids them;
 * any model sentence containing one is dropped rather than shown to contacts.
 */
const UNSUPPORTED_CLAIM =
  /\b(attack\w*|assault\w*|abduct\w*|kidnap\w*|rob(bed|bery)?|mugg\w*|stab\w*|shot|shoot\w*|gun\w*|weapon\w*|crash\w*|collision\w*|collid\w*|accident\w*|fell|fall(s|en|ing)?|faint\w*|unconscious\w*|seizure\w*|heart attack|stroke|injur\w*|bleed\w*|hurt|wound\w*|drunk|intoxicat\w*|overdos\w*|struggl\w*|fight\w*|violen\w*|chase\w*|follow(ed|ing)|threat\w*|danger(ous)?|unsafe)\b/i;

export function isGrounded(text: string): boolean {
  return !UNSUPPORTED_CLAIM.test(text);
}

// ── LLM output schema ─────────────────────────────────────────────────────────

const clipText = (max: number) => (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
};

const ModelOutputSchema = z.object({
  motionObservations: z
    .array(z.string())
    .max(20)
    .default([])
    .transform((items) =>
      items
        .map(clipText(200))
        .filter((s) => s.length > 0)
        .slice(0, 5),
    ),
  possibleContext: z
    .string()
    .nullable()
    .default(null)
    .transform((s) => (s === null ? null : clipText(400)(s) || null)),
  uncertainty: UncertaintySchema,
  evidenceQuality: EvidenceQualitySchema,
});

const SYSTEM_PROMPT = `You summarize sensor data for the emergency contacts of a person who pressed an SOS button on smart glasses. The SOS has ALREADY been sent; you do not decide whether they are in danger.

Rules:
- Use ONLY the JSON facts provided. Never invent incidents, injuries, attackers, vehicles, falls, medical events, weather, places, or the wearer's intent.
- Never use these words or synonyms: attack, assault, crash, collision, accident, fall, fell, injury, unconscious, seizure, violence, fight, weapon, threat, danger.
- Motion values are raw, uncalibrated sensor units with unknown axes. Describe them only relatively (for example "a sudden change in head movement about 40 s before the alert").
- You have no map data. Do not name or guess any street, building, neighborhood, or landmark.
- possibleContext must be hedged ("may", "consistent with") and stay neutral, or be null when the data does not support anything useful.
- Prefer null, empty arrays, and evidenceQuality "insufficient" over guessing. uncertainty must be "medium" or "high".

Reply with ONLY a JSON object of this exact shape:
{"motionObservations": string[] (max 5, each under 200 characters), "possibleContext": string | null (under 400 characters), "uncertainty": "medium" | "high", "evidenceQuality": "insufficient" | "limited" | "adequate"}`;

/** Facts for the model: no coordinates, no alert IDs, no contact data. */
function buildFacts(
  alert: AlertRecord,
  snapshot: EmergencySensorSnapshot,
  evidence: EvidenceAssessment,
) {
  const loc = snapshot.location;
  const motion = snapshot.motionSummary;
  const before = (atMs: number) => Math.round((alert.activatedAt - atMs) / 1000);
  return {
    sosActivatedAt: new Date(alert.activatedAt).toISOString(),
    location: loc
      ? {
          accuracyMeters: loc.accuracyMeters,
          secondsBeforeAlert: Math.round(locationAgeMs(loc, alert.activatedAt) / 1000),
          timeIsApproximate: loc.timestampSource === "received",
          stale: !evidence.locationUsable,
          speedMetersPerSecond: loc.speedMps ?? null,
        }
      : null,
    motion: motion
      ? {
          units: "raw uncalibrated SDK units, unknown axes",
          sampleCount: motion.sampleCount,
          windowSeconds: Math.round((motion.windowEndMs - motion.windowStartMs) / 1000),
          quality: motion.quality.level,
          effectiveSampleRateHz: motion.quality.effectiveSampleRateHz,
          observations: motion.observations.map((o) => ({
            kind: o.kind,
            secondsBeforeAlert: before(o.atMs),
            durationSeconds: o.durationMs === undefined ? null : Math.round(o.durationMs / 1000),
            detail: o.detail,
          })),
        }
      : null,
    diagnostics: snapshot.diagnostics,
    deterministicEvidenceQuality: evidence.quality,
  };
}

function extractJson(content: string): unknown {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

const QUALITY_RANK: Record<EvidenceQuality, number> = { insufficient: 0, limited: 1, adequate: 2 };
const UNCERTAINTY_RANK: Record<Uncertainty, number> = { low: 0, medium: 1, high: 2 };

export function createLiveContextService(
  ctx: ServiceContext,
  options: LiveContextOptions = {},
): HavenContextService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? CONTEXT_ANALYSIS_TIMEOUT_MS;
  const { llm } = ctx.config;
  const log = ctx.logger.child({ module: "context" });

  const result = (
    evidence: EvidenceAssessment,
    fields: Partial<
      Pick<
        ContextResult,
        "motionObservations" | "possibleContext" | "uncertainty" | "evidenceQuality"
      >
    > = {},
  ): ContextResult =>
    ContextResultSchema.parse({
      locationDescription: evidence.locationDescription,
      motionObservations: fields.motionObservations ?? evidence.motionObservations,
      possibleContext: fields.possibleContext ?? null,
      uncertainty: fields.uncertainty ?? evidence.uncertaintyFloor,
      evidenceQuality: fields.evidenceQuality ?? evidence.quality,
      model: llm.model,
      generatedAt: ctx.clock.now(),
    });

  async function analyze(
    alert: AlertRecord,
    sensorData: EmergencySensorSnapshot,
  ): Promise<ContextAnalysisOutcome> {
    if (!llm.apiKey)
      return { status: "failed", reason: "not_configured", detail: "LLM_API_KEY is not set" };

    const parsedSnapshot = EmergencySensorSnapshotSchema.safeParse(sensorData);
    const snapshot: EmergencySensorSnapshot = parsedSnapshot.success
      ? parsedSnapshot.data
      : {
          capturedAtMs: alert.activatedAt,
          location: null,
          motionSummary: null,
          diagnostics: ["Sensor data was invalid"],
        };
    const evidence = assessEvidence(alert, snapshot);

    // Nothing to analyze: answer deterministically and spend no model call.
    if (evidence.quality === "insufficient") {
      return { status: "insufficient_information", result: result(evidence) };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let content: string;
    try {
      const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(buildFacts(alert, snapshot, evidence)) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: "failed",
          reason: "provider_error",
          detail: `LLM HTTP ${response.status}`,
        };
      }
      const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
      const raw = body.choices?.[0]?.message?.content;
      if (typeof raw !== "string" || raw.trim() === "") {
        return { status: "failed", reason: "invalid_output", detail: "Empty model response" };
      }
      content = raw;
    } catch (error) {
      if (controller.signal.aborted) return { status: "failed", reason: "timeout" };
      return { status: "failed", reason: "provider_error", detail: String(error).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }

    let output: z.infer<typeof ModelOutputSchema>;
    try {
      output = ModelOutputSchema.parse(extractJson(content));
    } catch {
      return {
        status: "failed",
        reason: "invalid_output",
        detail: "Model output did not match the schema",
      };
    }

    // Grounding: drop any statement that asserts an incident; cap claims by the evidence.
    const observations = output.motionObservations.filter(isGrounded);
    const possibleContext =
      output.possibleContext && isGrounded(output.possibleContext) ? output.possibleContext : null;
    const evidenceQuality =
      QUALITY_RANK[output.evidenceQuality] <= QUALITY_RANK[evidence.quality]
        ? output.evidenceQuality
        : evidence.quality;
    const uncertainty =
      UNCERTAINTY_RANK[output.uncertainty] >= UNCERTAINTY_RANK[evidence.uncertaintyFloor]
        ? output.uncertainty
        : evidence.uncertaintyFloor;

    const final = result(evidence, {
      motionObservations: observations.length > 0 ? observations : evidence.motionObservations,
      possibleContext,
      uncertainty,
      evidenceQuality,
    });
    const status =
      final.evidenceQuality === "insufficient" ||
      (!final.possibleContext && final.motionObservations.length === 0)
        ? "insufficient_information"
        : "completed";
    return { status, result: final };
  }

  return {
    async analyzeEmergencyContext(alert, sensorData) {
      const started = Date.now();
      try {
        const outcome = await analyze(alert, sensorData);
        log.info("context analysis finished", {
          alertId: alert.alertId,
          status: outcome.status,
          reason: outcome.status === "failed" ? outcome.reason : undefined,
          ms: Date.now() - started,
        });
        return outcome;
      } catch (error) {
        log.error("context analysis crashed", {
          alertId: alert.alertId,
          error: String(error).slice(0, 200),
        });
        return {
          status: "failed",
          reason: "provider_error",
          detail: "Unexpected error during analysis",
        };
      }
    },
  };
}
