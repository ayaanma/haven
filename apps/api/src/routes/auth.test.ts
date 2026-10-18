import { afterEach, describe, expect, it } from "vitest";
import { CreateSessionResponseSchema, ROUTES, SESSION_TTL_MS } from "@haven/contracts";
import { sha256Hex } from "../lib/crypto";
import { createTestHarness, TEST_PAIRING_CODE, type TestHarness } from "../testing";

let h: TestHarness;
afterEach(() => h?.close());

const pair = (code: string) =>
  h.request(ROUTES.createSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: code, deviceLabel: "test G2" }),
  });

describe("POST /api/v1/auth/session", () => {
  it("exchanges the pairing code for a scoped bearer token", async () => {
    h = createTestHarness();
    const res = await pair(TEST_PAIRING_CODE);
    expect(res.status).toBe(201);
    const session = CreateSessionResponseSchema.parse(await res.json());
    expect(session.scopes).toEqual(
      expect.arrayContaining(["alerts:write", "contacts:read", "audio:write"]),
    );
    expect(session.expiresAt).toBe(h.clock.now() + SESSION_TTL_MS);

    const health = await h.request(ROUTES.alerts + "/x", {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    expect(health.status).not.toBe(401);
  });

  it("stores only a hash of the token", async () => {
    h = createTestHarness();
    const session = CreateSessionResponseSchema.parse(await (await pair(TEST_PAIRING_CODE)).json());
    const rows = h.db.all<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(rows.map((r) => r.token_hash)).toContain(sha256Hex(session.sessionToken));
    expect(JSON.stringify(rows)).not.toContain(session.sessionToken);
  });

  it("rejects a wrong pairing code", async () => {
    h = createTestHarness();
    const res = await pair("wrong-code");
    expect(res.status).toBe(401);
  });

  it("rate-limits repeated attempts", async () => {
    h = createTestHarness();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await pair("wrong-code")).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    h.clock.advance(5 * 60_000);
    expect((await pair(TEST_PAIRING_CODE)).status).toBe(201);
  });

  it("expires sessions after the TTL", async () => {
    h = createTestHarness();
    expect((await h.authed(`/api/v1/alerts/${"x"}`)).status).not.toBe(401);
    h.clock.advance(SESSION_TTL_MS);
    expect((await h.authed(ROUTES.contacts)).status).toBe(401);
  });

  it("rejects revoked sessions", async () => {
    h = createTestHarness();
    const session = h.container.sessions.authenticate(h.token);
    expect(session).not.toBeNull();
    h.container.sessions.revoke(session!.sessionId);
    expect((await h.authed(ROUTES.contacts)).status).toBe(401);
  });

  it("validates the request body", async () => {
    h = createTestHarness();
    const res = await h.request(ROUTES.createSession, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: TEST_PAIRING_CODE }),
    });
    expect(res.status).toBe(400);
  });
});
