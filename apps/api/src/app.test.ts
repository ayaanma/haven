import { afterEach, describe, expect, it } from "vitest";
import { ApiErrorBodySchema, HealthResponseSchema, ROUTES } from "@haven/contracts";
import { fixtureId, fixtureUuid, makeSOSRequest } from "@haven/contracts/testing";
import { createTestHarness, seedAlert, type TestHarness } from "./testing";

let h: TestHarness;
afterEach(() => h?.close());

const ALERT = fixtureId("alt", 1);

/** Every authenticated endpoint, with a representative request. */
const protectedEndpoints: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: ROUTES.contacts },
  { method: "PUT", path: ROUTES.contacts, body: { contacts: [] } },
  { method: "POST", path: ROUTES.alerts, body: makeSOSRequest() },
  { method: "GET", path: `/api/v1/alerts/${ALERT}` },
  { method: "GET", path: `/api/v1/alerts/${ALERT}/events` },
  { method: "POST", path: `/api/v1/alerts/${ALERT}/audio/chunks` },
  {
    method: "POST",
    path: `/api/v1/alerts/${ALERT}/audio/complete`,
    body: { recordingId: fixtureUuid(1), chunkCount: 1, durationMs: 1000, startedAt: 1 },
  },
];

describe("route registration", () => {
  it("serves health with integration modes, defaulting to mock", async () => {
    h = createTestHarness();
    const res = await h.request(ROUTES.health);
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(await res.json())).toEqual({
      status: "ok",
      photonMode: "mock",
      llmMode: "mock",
    });
  });

  it.each(protectedEndpoints)("$method $path requires a session", async ({ method, path }) => {
    h = createTestHarness();
    const res = await h.request(path, { method });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toBeTruthy();
  });

  it("rejects a malformed or unknown token", async () => {
    h = createTestHarness();
    for (const header of ["Bearer nope", `Bearer hvn_${"x".repeat(43)}`, "Basic abc"]) {
      const res = await h.request(ROUTES.contacts, { headers: { Authorization: header } });
      expect(res.status).toBe(401);
    }
  });

  it("registers every feature route, implemented or placeholder (never the unknown-route 404)", async () => {
    h = createTestHarness();
    const featureRoutes = [
      { method: "GET", path: ROUTES.contacts },
      { method: "PUT", path: ROUTES.contacts, body: { contacts: [] } },
      { method: "POST", path: ROUTES.alerts, body: makeSOSRequest() },
      { method: "GET", path: `/api/v1/alerts/${ALERT}` },
    ];
    for (const { method, path, body } of featureRoutes) {
      const res = await h.json(method, path, body);
      const payload = (await res.json()) as { error?: { message?: string } };
      expect(payload.error?.message, `${method} ${path}`).not.toBe("Route not found");
    }
  });

  it("serves the events endpoint from the foundation event log", async () => {
    h = createTestHarness();
    const alertId = seedAlert(h.db, { now: h.clock.now() });
    h.container.events.append(alertId, {
      type: "recording.started",
      payload: { recordingId: fixtureUuid(9) },
    });
    const res = await h.authed(`/api/v1/alerts/${alertId}/events`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { events: unknown[]; nextCursor: string; hasMore: boolean };
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^\d+$/);
    expect(page.hasMore).toBe(false);

    const missing = await h.authed(`/api/v1/alerts/${fixtureId("alt", 99)}/events`);
    expect(missing.status).toBe(404);
  });

  it("validates bodies before reaching feature code", async () => {
    h = createTestHarness();
    const badJson = await h.authed(ROUTES.alerts, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);

    const badSos = await h.json("POST", ROUTES.alerts, { clientAlertId: "not-a-uuid" });
    expect(badSos.status).toBe(400);
    const body = ApiErrorBodySchema.parse(await badSos.json());
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues?.length).toBeGreaterThan(0);

    const badId = await h.authed("/api/v1/alerts/not-an-id");
    expect(badId.status).toBe(400);
  });

  it("rejects oversized JSON bodies", async () => {
    h = createTestHarness();
    const res = await h.json("POST", ROUTES.alerts, { padding: "x".repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });

  it("registers the webhook and recording-link routes without session auth", async () => {
    h = createTestHarness();
    const webhook = await h.request(ROUTES.photonWebhooks, { method: "POST", body: "{}" });
    expect(webhook.status).not.toBe(404);
    const shortToken = await h.request("/r/x");
    expect(shortToken.status).toBe(404);
    // Registered, implemented or placeholder: an unknown token is never the unknown-route 404.
    const share = await h.request(`/r/${"a".repeat(43)}`);
    const shareBody = (await share.json()) as { error?: { message?: string } };
    expect(shareBody.error?.message).not.toBe("Route not found");
  });

  it("returns the error envelope for unknown routes", async () => {
    h = createTestHarness();
    const res = await h.request("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe("not_found");
  });

  it("answers CORS preflight for the WebView", async () => {
    h = createTestHarness();
    const res = await h.request(ROUTES.alerts, {
      method: "OPTIONS",
      headers: {
        Origin: "http://192.168.1.20:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
  });

  it("restricts CORS to configured origins", async () => {
    h = createTestHarness({ env: { ALLOWED_ORIGINS: "https://a.example,https://b.example" } });
    const allowed = await h.request(ROUTES.health, { headers: { Origin: "https://b.example" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://b.example");
    const denied = await h.request(ROUTES.health, { headers: { Origin: "https://evil.example" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
