// The live transport against a stub of Photon 2.0 (no network). Response bodies follow the
// Photon OpenAPI contract, so the real @photon-ai/api client validates them as it would in
// production.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContactRow } from "../contacts/repository";
import { testConfig } from "../testing";
import { createLivePhotonTransport } from "./live-transport";
import {
  PHONES,
  allEvents,
  createPhotonHarness,
  getAlert,
  seedVerifiedContacts,
  waitForEvent,
  type PhotonHarness,
} from "./testing";
import type { OutboundMessage } from "./transport";

const PROJECT = "pho_prj_01k0000000000000000000000a";
const AGENT = "pho_usr_01k00000000000000000000agt";
const USER = "pho_usr_01k00000000000000000000usr";
const SPACE = "pho_spc_01k00000000000000000000spc";
const API_KEY = "pho_sk_test_0123456789";
const LIVE_ENV = {
  PHOTON_MODE: "live",
  PHOTON_API_KEY: API_KEY,
  PHOTON_PROJECT_ID: PROJECT,
  PHOTON_AGENT_USER_ID: AGENT,
  PHOTON_WEBHOOK_SECRET: `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`,
  PUBLIC_BASE_URL: "https://haven.example",
};

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const at = "2026-10-18T19:30:00.000Z";
const userBody = (id: string = USER, handle: string = PHONES[0]) => ({
  id,
  handle,
  kind: "human",
  platform: "imessage",
  projectId: PROJECT,
  details: {},
  metadata: {},
  createdAt: at,
  updatedAt: at,
});
const snapshot = <T extends Record<string, unknown>>(value: T) => {
  const { createdAt: _c, updatedAt: _u, ...rest } = value;
  return rest;
};
const spaceBody = () => ({
  id: SPACE,
  kind: "direct",
  platform: "imessage",
  projectId: PROJECT,
  participantIds: [AGENT, USER],
  details: {},
  metadata: {},
  createdAt: at,
  updatedAt: at,
});
const sentBody = (id: string, text: string, status = "dispatched") => ({
  id,
  status,
  platform: "imessage",
  projectId: PROJECT,
  content: { type: "text", format: "plain", text },
  sentBy: snapshot(userBody(AGENT, "+14155550000")),
  space: snapshot(spaceBody()),
  metadata: {},
  timestamps: status === "delivered" ? { dispatchedAt: at, deliveredAt: at } : { dispatchedAt: at },
  createdAt: at,
  updatedAt: at,
});
const problem = (status: number, code: string) => ({
  status,
  body: {
    type: `https://photon.codes/docs/problems/${code.toLowerCase()}`,
    title: code,
    status,
    code,
  },
  headers: { "content-type": "application/problem+json" },
});

/** A stub of the three Photon endpoints Haven uses. */
function fakePhoton(override: (seen: Seen, count: number) => Reply | undefined = () => undefined) {
  const seen: Seen[] = [];
  let messageCount = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const entry: Seen = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
    seen.push(entry);
    const custom = override(entry, seen.length);
    let reply: Reply;
    if (custom) reply = custom;
    else if (entry.path.endsWith("/users")) reply = { status: 201, body: userBody() };
    else if (entry.path.endsWith("/spaces")) reply = { status: 201, body: spaceBody() };
    else if (entry.path.endsWith("/messages")) {
      messageCount++;
      const content = entry.body?.content as { text: string };
      reply = {
        status: 202,
        body: sentBody(`pho_msg_01k0000000000000000000000${messageCount}`, content.text),
      };
    } else reply = problem(404, "NOT_FOUND");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
  return { fetch, seen };
}

const message = (overrides: Partial<OutboundMessage["recipient"]> = {}): OutboundMessage => ({
  notificationId: "ntf_1",
  kind: "initial_sos",
  idempotencyKey: "haven:alt_x:ctc_y:initial_sos",
  text: "HAVEN SOS ALERT\n...",
  recipient: {
    contactId: "ctc_y",
    phoneNumber: PHONES[0],
    userId: null,
    spaceId: null,
    ...overrides,
  },
});

const liveConfig = () => testConfig(LIVE_ENV);

let h: PhotonHarness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

describe("live Photon transport", () => {
  it("resolves the user and space, then sends with stable idempotency keys", async () => {
    const photon = fakePhoton();
    const transport = createLivePhotonTransport(liveConfig(), {
      fetch: photon.fetch,
      maxAttempts: 1,
    });
    const outcome = await transport.send(message());

    expect(outcome).toEqual({
      ok: true,
      providerMessageId: "pho_msg_01k00000000000000000000001",
      providerStatus: "dispatched",
      failureCode: null,
      replayed: false,
      identity: { userId: USER, spaceId: SPACE },
    });
    expect(photon.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /v1/projects/${PROJECT}/users`,
      `POST /v1/projects/${PROJECT}/spaces`,
      `POST /v1/projects/${PROJECT}/messages`,
    ]);
    for (const request of photon.seen) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    }
    const [user, space, send] = photon.seen;
    expect(user?.body).toEqual({ handle: PHONES[0], platform: "imessage" });
    expect(space?.body).toEqual({ participantIds: [AGENT, USER], platform: "imessage" });
    expect(space?.headers.get("idempotency-key")).toBe(`haven-space:${AGENT}:${USER}`);
    expect(send?.body).toEqual({
      spaceId: SPACE,
      senderId: AGENT,
      content: { type: "text", format: "plain", text: "HAVEN SOS ALERT\n..." },
    });
    expect(send?.headers.get("idempotency-key")).toBe("haven:alt_x:ctc_y:initial_sos");
  });

  it("skips the lookups when the identity is cached and reports replays", async () => {
    const photon = fakePhoton((seen) =>
      seen.path.endsWith("/messages")
        ? {
            status: 202,
            body: sentBody("pho_msg_01k0000000000000000000000r", "x", "delivered"),
            headers: { "idempotent-replayed": "true" },
          }
        : undefined,
    );
    const transport = createLivePhotonTransport(liveConfig(), {
      fetch: photon.fetch,
      maxAttempts: 1,
    });
    const outcome = await transport.send(message({ userId: USER, spaceId: SPACE }));
    expect(photon.seen).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true, providerStatus: "delivered", replayed: true });
  });

  it("reports a 202 it cannot decode as accepted, without inventing an ID", async () => {
    const photon = fakePhoton((seen) =>
      seen.path.endsWith("/messages") ? { status: 202, body: { unexpected: true } } : undefined,
    );
    const transport = createLivePhotonTransport(liveConfig(), {
      fetch: photon.fetch,
      maxAttempts: 1,
    });
    expect(await transport.send(message({ userId: USER, spaceId: SPACE }))).toEqual({
      ok: true,
      providerMessageId: null,
      providerStatus: "dispatched",
      failureCode: null,
      replayed: false,
      identity: { userId: USER, spaceId: SPACE },
    });
  });

  it.each([
    [problem(403, "SHARED_LINE_INBOUND_REQUIRED"), false, "recipient_not_opted_in"],
    [problem(403, "SHARED_LINE_NOT_ASSIGNED"), false, "recipient_not_assigned"],
    [problem(422, "MESSAGE_TOO_LONG"), false, "message_rejected"],
    [problem(401, "NOT_AUTHENTICATED"), false, "provider_auth_failed"],
    [problem(503, "UPSTREAM_UNAVAILABLE"), true, "provider_unavailable"],
    [problem(429, "RATE_LIMITED"), true, "provider_rate_limited"],
    [problem(504, "UPSTREAM_TIMEOUT"), true, "provider_timeout"],
  ])("classifies %j", async (reply, retryable, failureCode) => {
    const photon = fakePhoton((seen) => (seen.path.endsWith("/messages") ? reply : undefined));
    const transport = createLivePhotonTransport(liveConfig(), {
      fetch: photon.fetch,
      maxAttempts: 1,
    });
    expect(await transport.send(message({ userId: USER, spaceId: SPACE }))).toEqual({
      ok: false,
      retryable,
      failureCode,
      identity: { userId: USER, spaceId: SPACE },
    });
  });

  it("forgets a stale space so the next attempt resolves it again", async () => {
    const photon = fakePhoton((seen) =>
      seen.path.endsWith("/messages") ? problem(404, "SPACE_NOT_FOUND") : undefined,
    );
    const transport = createLivePhotonTransport(liveConfig(), {
      fetch: photon.fetch,
      maxAttempts: 1,
    });
    expect(await transport.send(message({ userId: USER, spaceId: SPACE }))).toEqual({
      ok: false,
      retryable: true,
      failureCode: "space_not_found",
      identity: { userId: USER, spaceId: null },
    });
  });

  it("treats network failures as retryable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const transport = createLivePhotonTransport(liveConfig(), { fetch, maxAttempts: 1 });
    expect(await transport.send(message())).toMatchObject({
      ok: false,
      retryable: true,
      failureCode: "provider_unreachable",
    });
  });

  it("lets the client retry a transient status with the same idempotency key", async () => {
    const photon = fakePhoton((seen, count) =>
      seen.path.endsWith("/messages") && count === 1
        ? problem(503, "UPSTREAM_UNAVAILABLE")
        : undefined,
    );
    const transport = createLivePhotonTransport(liveConfig(), {
      fetch: photon.fetch,
      maxAttempts: 2,
    });
    const outcome = await transport.send(message({ userId: USER, spaceId: SPACE }));
    expect(outcome.ok).toBe(true);
    expect(photon.seen.map((r) => r.headers.get("idempotency-key"))).toEqual([
      "haven:alt_x:ctc_y:initial_sos",
      "haven:alt_x:ctc_y:initial_sos",
    ]);
  });
});

describe("live mode end to end (stubbed Photon)", () => {
  it("sends the SOS through Photon and caches the contact's Photon identity", async () => {
    const photon = fakePhoton();
    const config = liveConfig();
    h = createPhotonHarness({
      env: LIVE_ENV,
      transport: createLivePhotonTransport(config, { fetch: photon.fetch, maxAttempts: 1 }),
    });
    const [contactId] = seedVerifiedContacts(h, 1);
    const { body } = await (async () => {
      const res = await h!.json("POST", "/api/v1/alerts", {
        clientAlertId: "00000000-0000-4000-8000-0000000000aa",
        activatedAt: h!.clock.now() - 5_000,
      });
      return { body: (await res.json()) as { alert: { alertId: string } } };
    })();
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");

    const alert = await getAlert(h, body.alert.alertId);
    expect(alert.recipients[0]).toMatchObject({ contactId, status: "photon_accepted" });
    const row = h.db.get<{ photon_message_id: string }>(
      "SELECT photon_message_id FROM alert_notifications WHERE alert_id = ?",
      body.alert.alertId,
    );
    expect(row?.photon_message_id).toBe("pho_msg_01k00000000000000000000001");
    expect(getContactRow(h.db, contactId!)).toMatchObject({
      photon_user_id: USER,
      photon_space_id: SPACE,
    });
    const send = photon.seen.find((r) => r.path.endsWith("/messages"));
    expect((send?.body?.content as { text: string }).text).toContain("Location: unavailable");
    expect(h.db.all("SELECT * FROM mock_outbox")).toEqual([]);
    expect((await allEvents(h, body.alert.alertId))[0]?.type).toBe("sos.received");
  });
});
