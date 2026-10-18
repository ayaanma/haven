import { describe, expect, it, vi } from "vitest";
import {
  ContextAnalysisOutcomeSchema,
  HAVEN_LLM_MODEL,
  type ContextAnalysisOutcome,
  type EmergencySensorSnapshot,
} from "@haven/contracts";
import {
  FIXTURE_NOW_MS,
  makeAlertRecord,
  makeEmptyMotionSummary,
  makeLocationFix,
  makeMotionSummary,
} from "@haven/contracts/testing";
import type { ServiceContext } from "../lib/interfaces";
import { silentLogger } from "../lib/logger";
import { FakeClock, testConfig } from "../testing";
import {
  assessEvidence,
  createContextService,
  createLiveContextService,
  isGrounded,
} from "./index";

const alert = makeAlertRecord();

function makeCtx(
  env: Record<string, string> = { LLM_MODE: "live", LLM_API_KEY: "test-key" },
): ServiceContext {
  return {
    config: testConfig(env),
    clock: new FakeClock(FIXTURE_NOW_MS),
    logger: silentLogger,
  } as unknown as ServiceContext;
}

function snapshot(overrides: Partial<EmergencySensorSnapshot> = {}): EmergencySensorSnapshot {
  return {
    capturedAtMs: alert.activatedAt,
    location: makeLocationFix({ timestampMs: alert.activatedAt - 4_000 }),
    motionSummary: makeMotionSummary(),
    diagnostics: [],
    ...overrides,
  };
}

function llm(content: unknown, status = 200) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status }),
  );
}

function expectValid(outcome: ContextAnalysisOutcome) {
  expect(ContextAnalysisOutcomeSchema.safeParse(outcome).success).toBe(true);
}

describe("createContextService", () => {
  it("mock mode never calls a model and never makes claims", async () => {
    const service = createContextService(makeCtx({}));
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expectValid(outcome);
    expect(outcome.status).toBe("insufficient_information");
  });
});

describe("createLiveContextService", () => {
  it("returns a validated, evidence-capped result and never sends coordinates", async () => {
    const fetch = llm({
      motionObservations: ["Sudden change in head movement about 41 s before the alert"],
      possibleContext: "Movement may be consistent with a sudden stop or quick turn",
      uncertainty: "low",
      evidenceQuality: "adequate",
    });
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expectValid(outcome);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.model).toBe(HAVEN_LLM_MODEL);
    expect(outcome.result.evidenceQuality).toBe("limited"); // capped by the deterministic assessment
    expect(outcome.result.uncertainty).toBe("high"); // never lower than the floor
    expect(outcome.result.locationDescription).toContain("accurate to about 12 m");

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toMatch(/\/chat\/completions$/);
    const body = String(init?.body);
    expect(body).toContain(`"model":"${HAVEN_LLM_MODEL}"`);
    expect(body).not.toContain("34.068921");
    expect(body).not.toContain("-118.445181");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
  });

  it("drops statements that assert incidents instead of passing them to contacts", async () => {
    const fetch = llm({
      motionObservations: [
        "The wearer fell to the ground",
        "Abrupt head movement about 41 s before the alert",
      ],
      possibleContext: "The wearer was attacked",
      uncertainty: "medium",
      evidenceQuality: "limited",
    });
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expectValid(outcome);
    if (outcome.status === "failed") throw new Error("unexpected failure");
    expect(outcome.result.possibleContext).toBeNull();
    expect(outcome.result.motionObservations).toEqual([
      "Abrupt head movement about 41 s before the alert",
    ]);
  });

  it("reports invalid JSON as invalid_output", async () => {
    const fetch = llm("this is not json");
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expect(outcome).toMatchObject({ status: "failed", reason: "invalid_output" });
  });

  it("reports schema mismatches as invalid_output", async () => {
    const fetch = llm({ motionObservations: [], possibleContext: null });
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expect(outcome).toMatchObject({ status: "failed", reason: "invalid_output" });
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const fetch = llm(
      '```json\n{"motionObservations":[],"possibleContext":"Movement may reflect a quick turn","uncertainty":"high","evidenceQuality":"limited"}\n```',
    );
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expect(outcome.status).toBe("completed");
  });

  it("reports provider errors such as a 404 for model access", async () => {
    const fetch = llm({}, 404);
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "provider_error",
      detail: "LLM HTTP 404",
    });
  });

  it("times out instead of hanging", async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const service = createLiveContextService(makeCtx(), {
      fetch: hanging as unknown as typeof globalThis.fetch,
      timeoutMs: 20,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expect(outcome).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("never rejects when fetch throws", async () => {
    const broken = vi.fn(async () => {
      throw new Error("network down");
    });
    const service = createLiveContextService(makeCtx(), {
      fetch: broken as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(alert, snapshot());
    expect(outcome).toMatchObject({ status: "failed", reason: "provider_error" });
  });

  it("skips the model when there is no usable evidence", async () => {
    const fetch = llm({});
    const service = createLiveContextService(makeCtx(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const outcome = await service.analyzeEmergencyContext(
      alert,
      snapshot({ location: null, motionSummary: makeEmptyMotionSummary() }),
    );
    expectValid(outcome);
    expect(outcome.status).toBe("insufficient_information");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports not_configured without an API key", async () => {
    const ctx = makeCtx();
    const noKey = {
      ...ctx,
      config: { ...ctx.config, llm: { ...ctx.config.llm, apiKey: undefined } },
    } as ServiceContext;
    const outcome = await createLiveContextService(noKey).analyzeEmergencyContext(
      alert,
      snapshot(),
    );
    expect(outcome).toMatchObject({ status: "failed", reason: "not_configured" });
  });
});

describe("assessEvidence", () => {
  it("treats stale locations as unusable and labels them last known", () => {
    const evidence = assessEvidence(
      alert,
      snapshot({
        location: makeLocationFix({ timestampMs: alert.activatedAt - 10 * 60_000 }),
        motionSummary: null,
      }),
    );
    expect(evidence.locationUsable).toBe(false);
    expect(evidence.quality).toBe("insufficient");
    expect(evidence.locationDescription).toMatch(/^Last known/);
  });

  it("rates good motion plus a fresh, accurate fix as adequate", () => {
    const motionSummary = makeMotionSummary({
      quality: { level: "good", effectiveSampleRateHz: 10, longestGapMs: 200, notes: [] },
    });
    expect(assessEvidence(alert, snapshot({ motionSummary })).quality).toBe("adequate");
  });
});

describe("isGrounded", () => {
  it("rejects incident claims and accepts neutral measurements", () => {
    expect(isGrounded("The wearer was attacked")).toBe(false);
    expect(isGrounded("Possible car crash")).toBe(false);
    expect(isGrounded("Sudden change in head movement about 40 s before the alert")).toBe(true);
  });
});
