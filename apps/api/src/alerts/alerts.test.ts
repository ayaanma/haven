import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlertEventsPageSchema,
  AlertRecordSchema,
  ApiErrorBodySchema,
  CreateAlertResponseSchema,
  ROUTES,
  type AlertEvent,
  type ContextAnalysisOutcome,
} from "@haven/contracts";
import { fixtureId, makeContextResult } from "@haven/contracts/testing";
import { FakeContextService, seedContact } from "../testing";
import {
  PHONES,
  allEvents,
  completedContext,
  createPhotonHarness,
  eventTypes,
  flush,
  getAlert,
  outbox,
  postSOS,
  seedVerifiedContacts,
  sosRequest,
  waitForEvent,
  type PhotonHarness,
} from "../photon/testing";

let h: PhotonHarness;
afterEach(() => {
  h?.close();
  vi.restoreAllMocks();
});

describe("POST /api/v1/alerts", () => {
  it("requires a session and a valid body", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 1);
    const unauthenticated = await h.request(ROUTES.alerts, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sosRequest()),
    });
    expect(unauthenticated.status).toBe(401);
    const invalid = await h.json("POST", ROUTES.alerts, { ...sosRequest(), extra: true });
    expect(invalid.status).toBe(400);
    expect(outbox(h)).toEqual([]);
  });

  it("fails honestly when no contact is eligible", async () => {
    const context = new FakeContextService(completedContext());
    h = createPhotonHarness({ context });
    seedContact(h.db, { phoneNumber: PHONES[0], consentStatus: "pending" });
    seedContact(h.db, { phoneNumber: PHONES[1], consentStatus: "revoked" });
    seedContact(h.db, { phoneNumber: PHONES[2], consentStatus: "verified", enabled: false });

    const { status, body } = await postSOS(h);
    expect(status).toBe(201);
    expect(body.alert).toMatchObject({
      state: "notification_failed",
      totalRecipients: 0,
      recipients: [],
      initialAcceptedCount: 0,
      aiAnalysis: { status: "skipped" },
    });
    await flush();
    const events = await allEvents(h, body.alert.alertId);
    expect(eventTypes(events)).toEqual(["sos.received", "alert.initial_notification_failed"]);
    expect(events[1]?.payload).toEqual({ reason: "no_eligible_contacts", totalRecipients: 0 });
    expect(outbox(h)).toEqual([]);
    expect(context.calls).toHaveLength(0);
  });

  it("sends the initial SOS to every eligible contact", async () => {
    h = createPhotonHarness();
    const ids = seedVerifiedContacts(h, 3);
    seedContact(h.db, { phoneNumber: "+14155550199", consentStatus: "pending" });

    const { status, body } = await postSOS(h);
    expect(status).toBe(201);
    expect(CreateAlertResponseSchema.parse(body).created).toBe(true);
    expect(body.alert.alertId).toMatch(/^alt_[0-9a-z]{24}$/);
    expect(body.alert.totalRecipients).toBe(3);

    const alertId = body.alert.alertId;
    await waitForEvent(h, alertId, "alert.initial_notification_accepted");
    const sent = outbox(h).filter((row) => row.kind === "initial_sos");
    expect(sent.map((row) => row.to_handle).sort()).toEqual([...PHONES.slice(0, 3)].sort());
    for (const row of sent) {
      expect(row.body).toContain("HAVEN SOS ALERT");
      expect(row.body).toContain("call 911");
      expect(row.body).toContain("google.com/maps");
    }

    const alert = AlertRecordSchema.parse(await getAlert(h, alertId));
    expect(alert).toMatchObject({
      state: "notified",
      initialAcceptedCount: 3,
      initialDeliveredCount: 0,
      totalRecipients: 3,
    });
    expect(alert.recipients.map((r) => [r.contactId, r.status])).toEqual(
      ids.map((id) => [id, "photon_accepted"]),
    );
    expect(alert.latestEventCursor).toMatch(/^\d+$/);
  });

  it("emits the recording trigger exactly once, on the first acceptance", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 3);
    const { body } = await postSOS(h);
    const events = await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    await flush();
    const all = await allEvents(h, body.alert.alertId);
    // Context analysis runs in parallel; its events may interleave anywhere.
    const types = eventTypes(all).filter((type) => !type.startsWith("context."));
    expect(types.filter((t) => t === "alert.initial_notification_accepted")).toHaveLength(1);
    // Ordered: SOS persisted → first Photon acceptance → recording trigger → the others.
    expect(types.slice(0, 5)).toEqual([
      "sos.received",
      "notification.photon_accepted",
      "alert.initial_notification_accepted",
      "notification.photon_accepted",
      "notification.photon_accepted",
    ]);
    const trigger = events.find((e) => e.type === "alert.initial_notification_accepted");
    expect(trigger?.payload).toEqual({ acceptedCount: 1, totalRecipients: 3 });
    const accepted = all.filter((e) => e.type === "notification.photon_accepted");
    for (const event of accepted) {
      expect(event.payload).toMatchObject({ kind: "initial_sos", status: "photon_accepted" });
    }
  });

  it("never sends twice for a repeated clientAlertId (first write wins)", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 2);
    const first = await postSOS(h, sosRequest(7));
    await waitForEvent(h, first.body.alert.alertId, "alert.initial_notification_accepted");
    await flush();
    const sentBefore = outbox(h).length;
    const eventsBefore = await allEvents(h, first.body.alert.alertId);

    const retry = await postSOS(h, sosRequest(7, { location: undefined, activatedAt: 1 }));
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.alert.alertId).toBe(first.body.alert.alertId);
    expect(retry.body.alert.activatedAt).toBe(first.body.alert.activatedAt);
    expect(retry.body.alert.location).toEqual(first.body.alert.location);
    await flush();
    expect(outbox(h)).toHaveLength(sentBefore);
    expect(await allEvents(h, first.body.alert.alertId)).toEqual(eventsBefore);
  });

  it("creates one alert for concurrent duplicate requests", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 2);
    const results = await Promise.all([postSOS(h), postSOS(h), postSOS(h)]);
    expect(results.filter((r) => r.body.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.alert.alertId)).size).toBe(1);
    await waitForEvent(h, results[0]!.body.alert.alertId, "alert.initial_notification_accepted");
    await flush();
    expect(outbox(h).filter((r) => r.kind === "initial_sos")).toHaveLength(2);
  });

  it("sends the SOS when the request has no location or motion data", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(
      h,
      sosRequest(3, { location: undefined, motionSummary: undefined }),
    );
    expect(body.alert.location).toBeNull();
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    expect(outbox(h)[0]?.body).toContain("Location: unavailable");
  });
});

describe("AI context follow-up", () => {
  it("does not hold the initial SOS for analysis", async () => {
    const context = new FakeContextService(completedContext(), 400);
    h = createPhotonHarness({ context });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    const events = await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    expect(context.calls).toHaveLength(1);
    expect(events.some((e) => e.type.startsWith("context."))).toBe(false);
    expect(outbox(h).every((row) => row.kind === "initial_sos")).toBe(true);
  });

  it("sends a separate, hedged context update afterward", async () => {
    const context = new FakeContextService(completedContext(), 20);
    h = createPhotonHarness({ context });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    const alertId = body.alert.alertId;
    await waitForEvent(h, alertId, "context.completed");
    await vi.waitFor(() => {
      expect(outbox(h).filter((row) => row.kind === "context_update")).toHaveLength(2);
    });

    const rows = outbox(h);
    const lastInitial = Math.max(...rows.filter((r) => r.kind === "initial_sos").map((r) => r.id));
    const firstContext = Math.min(
      ...rows.filter((r) => r.kind === "context_update").map((r) => r.id),
    );
    expect(firstContext).toBeGreaterThan(lastInitial);
    const update = rows.find((r) => r.kind === "context_update")!.body;
    expect(update).toContain("HAVEN CONTEXT UPDATE");
    expect(update).toContain("Near the intersection of Westwood Blvd");
    expect(update).toContain("It can be wrong");

    // The analysis saw the SOS request's sensor data.
    const call = context.calls[0]!;
    expect(call.alert.alertId).toBe(alertId);
    expect(call.sensorData.location).toEqual(sosRequest().location);
    expect(call.sensorData.motionSummary).toEqual(sosRequest().motionSummary);

    const alert = await getAlert(h, alertId);
    expect(alert.aiAnalysis.status).toBe("completed");
    const types = eventTypes(await allEvents(h, alertId));
    expect(types.filter((t) => t === "notification.photon_accepted")).toHaveLength(4);
    expect(types.indexOf("context.completed")).toBeGreaterThan(
      types.indexOf("alert.initial_notification_accepted"),
    );
  });

  it("sends nothing extra when there is not enough information", async () => {
    const outcome: ContextAnalysisOutcome = {
      status: "insufficient_information",
      result: makeContextResult(),
    };
    h = createPhotonHarness({ context: new FakeContextService(outcome) });
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "context.insufficient_information");
    await flush();
    expect(outbox(h).map((r) => r.kind)).toEqual(["initial_sos"]);
    expect((await getAlert(h, body.alert.alertId)).aiAnalysis.status).toBe(
      "insufficient_information",
    );
  });

  it.each([
    [
      "reports failure",
      () => new FakeContextService({ status: "failed", reason: "provider_error" }),
      "provider_error",
    ],
    [
      "throws",
      () => ({
        analyzeEmergencyContext: () => Promise.reject(new Error("boom")),
      }),
      "provider_error",
    ],
    [
      "returns invalid output",
      () => new FakeContextService({ status: "completed" } as unknown as ContextAnalysisOutcome),
      "invalid_output",
    ],
    [
      "never answers",
      () => ({ analyzeEmergencyContext: () => new Promise<never>(() => {}) }),
      "timeout",
    ],
  ])("leaves the SOS untouched when analysis %s", async (_name, make, reason) => {
    h = createPhotonHarness({ context: make(), contextTimeoutMs: 50 });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    const alertId = body.alert.alertId;
    const events = await waitForEvent(h, alertId, "context.failed");
    expect(events.find((e) => e.type === "context.failed")?.payload).toEqual({ reason });
    expect(eventTypes(events)).toContain("alert.initial_notification_accepted");
    await flush();
    expect(outbox(h).map((r) => r.kind)).toEqual(["initial_sos", "initial_sos"]);
    const alert = await getAlert(h, alertId);
    expect(alert).toMatchObject({ state: "notified", initialAcceptedCount: 2 });
    expect(alert.aiAnalysis.status).toBe("failed");
  });
});

describe("GET /api/v1/alerts/:alertId", () => {
  it("returns 404 for an unknown alert and 400 for a malformed ID", async () => {
    h = createPhotonHarness();
    expect((await h.json("GET", `/api/v1/alerts/${fixtureId("alt", 5)}`)).status).toBe(404);
    const bad = await h.json("GET", "/api/v1/alerts/alt_nope");
    expect(bad.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await bad.json()).error.code).toBe("invalid_request");
  });
});

describe("GET /api/v1/alerts/:alertId/events", () => {
  it("pages in strictly increasing order without skipping or repeating", async () => {
    h = createPhotonHarness({ context: new FakeContextService(completedContext()) });
    seedVerifiedContacts(h, 3);
    const a = (await postSOS(h, sosRequest(1))).body.alert.alertId;
    const b = (await postSOS(h, sosRequest(2))).body.alert.alertId;
    await vi.waitFor(async () => {
      const types = eventTypes(await allEvents(h, a));
      expect(types.filter((t) => t === "notification.photon_accepted")).toHaveLength(6);
    });
    await waitForEvent(h, b, "context.completed");
    await flush();
    const full = await allEvents(h, a);

    const paged: AlertEvent[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const res = await h.json("GET", `/api/v1/alerts/${a}/events${query}`);
      expect(res.status).toBe(200);
      const page = AlertEventsPageSchema.parse(await res.json());
      expect(page.events.length).toBeLessThanOrEqual(2);
      expect(page.hasMore).toBe(page.events.length === 2);
      paged.push(...page.events);
      if (page.events.length === 0) {
        expect(page.nextCursor).toBe(cursor);
        break;
      }
      expect(page.nextCursor).toBe(String(page.events.at(-1)!.id));
      cursor = page.nextCursor;
    }
    expect(paged).toEqual(full);
    const ids = paged.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
    expect(paged.every((e) => e.alertId === a)).toBe(true);
    expect(paged[0]?.type).toBe("sos.received");

    // Polling at the end returns nothing new and keeps the cursor.
    const tail = await h.json("GET", `/api/v1/alerts/${a}/events?cursor=${cursor}`);
    expect(AlertEventsPageSchema.parse(await tail.json())).toEqual({
      events: [],
      nextCursor: cursor,
      hasMore: false,
    });
  });

  it("validates the cursor and limit", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    const base = `/api/v1/alerts/${body.alert.alertId}/events`;
    for (const query of ["?cursor=abc", "?limit=0", "?limit=101", "?cursor=1&foo=2"]) {
      expect((await h.json("GET", `${base}${query}`)).status, query).toBe(400);
    }
    expect((await h.json("GET", `/api/v1/alerts/${fixtureId("alt", 9)}/events`)).status).toBe(404);
  });
});
