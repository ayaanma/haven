// Owner: Agent 3. Placeholder created by the foundation commit.
//
// Live mode: call the OpenAI-compatible chat completions endpoint at LLM_BASE_URL with
// model HAVEN_LLM_MODEL ("gemini-2.5-flash-lite", enforced by config), ask for JSON
// matching ContextResultSchema, validate it, and enforce CONTEXT_ANALYSIS_TIMEOUT_MS.
// Never invent incidents. Prefer `insufficient_information` over guessing.
import type { ContextResult } from "@haven/contracts";
import type { HavenContextService, ServiceContext } from "../lib/interfaces";

export function createContextService(ctx: ServiceContext): HavenContextService {
  if (ctx.config.llm.mode === "mock") return createMockContextService(ctx);
  return {
    async analyzeEmergencyContext() {
      return {
        status: "failed",
        reason: "not_configured",
        detail: "Live context analysis is not implemented yet (Agent 3)",
      };
    },
  };
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
