import { afterEach, describe, expect, it, vi } from "vitest";
import { makeContextResult } from "@haven/contracts/testing";
import { setContactConsent } from "../contacts/repository";
import { FakeContextService, seedContact, testConfig } from "../testing";
import { createLivePhotonTransport } from "./live-transport";
import {
  PHONES,
  ScriptedTransport,
  accept,
  allEvents,
  completedContext,
  createPhotonHarness,
  eventTypes,
  fastRetry,
  flush,
  getAlert,
  outbox,
  permanentFailure,
  postSOS,
  seedVerifiedContacts,
  sosRequest,
  transientFailure,
  waitForEvent,
  type PhotonHarness,
} from "./testing";

let h: PhotonHarness;
afterEach(() => {
  h?.close();
  vi.restoreAllMocks();
});

/** Event types without `context.*`, which runs in parallel and may interleave. */
const deliveryEvents = (events: Parameters<typeof eventTypes>[0]) =>
  eventTypes(events).filter((type) => !type.startsWith("context."));

const RECORDING_URL = "https://haven.example/r/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

describe("initial SOS delivery", () => {
  it("retries outages with the same idempotency key and sends one message", async () => {
    const transport = new ScriptedTransport((message, attempt) =>
      attempt < 3 ? transientFailure("provider_unavailable") : accept()(message, attempt),
    );
    h = createPhotonHarness({ transport, retry: fastRetry(5) });
    const [contactId] = seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    expect(body.alert.state).toBe("notifying");

    const events = await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    expect(transport.calls).toHaveLength(3);
    const keys = new Set(transport.calls.map((c) => c.idempotencyKey));
    expect([...keys]).toEqual([`haven:${body.alert.alertId}:${contactId}:initial_sos`]);
    expect(new Set(transport.calls.map((c) => c.text)).size).toBe(1);
    expect(deliveryEvents(events)).toEqual([
      "sos.received",
      "notification.photon_accepted",
      "alert.initial_notification_accepted",
    ]);
    expect((await getAlert(h, body.alert.alertId)).recipients[0]).toMatchObject({
      status: "photon_accepted",
      failureCode: null,
    });
  });

  it("fails a refused message at once, without retrying", async () => {
    const transport = new ScriptedTransport(() => permanentFailure("recipient_not_opted_in"));
    h = createPhotonHarness({ transport, retry: fastRetry(5) });
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    const events = await waitForEvent(h, body.alert.alertId, "alert.initial_notification_failed");
    await flush();
    expect(transport.calls).toHaveLength(1);
    expect(deliveryEvents(events)).toEqual([
      "sos.received",
      "notification.failed",
      "alert.initial_notification_failed",
    ]);
    expect(events.find((e) => e.type === "notification.failed")?.payload).toMatchObject({
      failureCode: "recipient_not_opted_in",
    });
    expect(events.find((e) => e.type === "alert.initial_notification_failed")?.payload).toEqual({
      reason: "all_sends_failed",
      totalRecipients: 1,
    });
    expect(await getAlert(h, body.alert.alertId)).toMatchObject({
      state: "notification_failed",
      initialAcceptedCount: 0,
    });
  });

  it("reports partial acceptance accurately and never counts failures as notified", async () => {
    const transport = new ScriptedTransport((message, attempt) => {
      if (message.recipient.phoneNumber === PHONES[1])
        return permanentFailure("recipient_unreachable");
      if (message.recipient.phoneNumber === PHONES[2]) return transientFailure("provider_timeout");
      return accept()(message, attempt);
    });
    h = createPhotonHarness({ transport, retry: fastRetry(3) });
    const [mom, dad, sam] = seedVerifiedContacts(h, 3);
    const { body } = await postSOS(h);
    const alertId = body.alert.alertId;
    await vi.waitFor(async () => {
      const alert = await getAlert(h, alertId);
      expect(alert.recipients.every((r) => r.status !== "queued")).toBe(true);
    });

    const alert = await getAlert(h, alertId);
    expect(alert).toMatchObject({ state: "notified", initialAcceptedCount: 1, totalRecipients: 3 });
    expect(alert.recipients).toEqual([
      expect.objectContaining({ contactId: mom, status: "photon_accepted", failureCode: null }),
      expect.objectContaining({
        contactId: dad,
        status: "failed",
        failureCode: "recipient_unreachable",
      }),
      expect.objectContaining({
        contactId: sam,
        status: "failed",
        failureCode: "provider_timeout",
      }),
    ]);
    expect(transport.callsTo(PHONES[2])).toHaveLength(3);
    const events = await allEvents(h, alertId);
    const trigger = events.filter((e) => e.type === "alert.initial_notification_accepted");
    expect(trigger.map((e) => e.payload)).toEqual([{ acceptedCount: 1, totalRecipients: 3 }]);
    expect(eventTypes(events)).not.toContain("alert.initial_notification_failed");
  });

  it("reports provider_unavailable when every send hit an outage", async () => {
    const transport = new ScriptedTransport(() => transientFailure("provider_unavailable"));
    h = createPhotonHarness({ transport, retry: fastRetry(2) });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    const events = await waitForEvent(h, body.alert.alertId, "alert.initial_notification_failed");
    expect(events.at(-1)?.payload).toEqual({ reason: "provider_unavailable", totalRecipients: 2 });
    expect(transport.calls).toHaveLength(4);
    expect(eventTypes(events)).not.toContain("alert.initial_notification_accepted");
  });

  it("keeps trying other contacts when one transport call throws", async () => {
    const transport = new ScriptedTransport((message, attempt) => {
      if (message.recipient.phoneNumber === PHONES[0]) throw new Error("socket hang up");
      return accept()(message, attempt);
    });
    h = createPhotonHarness({ transport, retry: fastRetry(1) });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    await flush();
    const alert = await getAlert(h, body.alert.alertId);
    expect(alert.recipients.map((r) => r.status)).toEqual(["failed", "photon_accepted"]);
  });

  it("maps provider statuses from the send response", async () => {
    const transport = new ScriptedTransport((message, attempt) =>
      accept(message.recipient.phoneNumber === PHONES[0] ? "delivered" : "accepted")(
        message,
        attempt,
      ),
    );
    h = createPhotonHarness({ transport });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    await flush();
    const alert = await getAlert(h, body.alert.alertId);
    expect(alert.recipients.map((r) => r.status)).toEqual(["delivered", "delivery_unconfirmed"]);
    expect(alert).toMatchObject({ initialAcceptedCount: 2, initialDeliveredCount: 1 });
    const types = eventTypes(await allEvents(h, body.alert.alertId));
    expect(types).toContain("notification.delivered");
    expect(types).toContain("notification.delivery_unconfirmed");
  });

  it("re-checks consent before every attempt", async () => {
    let revoke = () => {};
    const transport = new ScriptedTransport((message, attempt) => {
      if (attempt === 1) {
        revoke();
        return transientFailure();
      }
      return accept()(message, attempt);
    });
    h = createPhotonHarness({ transport, retry: fastRetry(3) });
    const [contactId] = seedVerifiedContacts(h, 1);
    revoke = () => setContactConsent(h.db, contactId!, "revoked", h.clock.now());
    const { body } = await postSOS(h);
    const events = await waitForEvent(h, body.alert.alertId, "alert.initial_notification_failed");
    expect(transport.calls).toHaveLength(1);
    expect(events.find((e) => e.type === "notification.failed")?.payload).toMatchObject({
      failureCode: "consent_revoked",
    });
  });

  it("limits how many messages one number receives per hour", async () => {
    h = createPhotonHarness({ hourlySendLimit: 1 });
    seedVerifiedContacts(h, 1);
    const first = await postSOS(h, sosRequest(1));
    await waitForEvent(h, first.body.alert.alertId, "alert.initial_notification_accepted");
    const second = await postSOS(h, sosRequest(2));
    const events = await waitForEvent(
      h,
      second.body.alert.alertId,
      "alert.initial_notification_failed",
    );
    expect(events.find((e) => e.type === "notification.failed")?.payload).toMatchObject({
      failureCode: "send_limit_exceeded",
    });
    expect(outbox(h)).toHaveLength(1);
  });

  it("resumes queued messages after a restart without sending duplicates", async () => {
    // First process: Photon never answers, so the row stays queued when it "crashes".
    const stuck = new ScriptedTransport(() => new Promise(() => {}));
    h = createPhotonHarness({ transport: stuck });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    await flush();
    expect(stuck.calls).toHaveLength(2);
    expect((await getAlert(h, body.alert.alertId)).state).toBe("notifying");

    // Second process on the same database recovers the outbox.
    const transport = new ScriptedTransport();
    const restarted = createPhotonHarness({
      db: h.db,
      clock: h.clock,
      transport,
      recoverOnStart: true,
    });
    await vi.waitFor(async () => {
      expect((await getAlert(restarted, body.alert.alertId)).initialAcceptedCount).toBe(2);
    });
    expect(transport.calls.map((c) => c.idempotencyKey)).toEqual(
      stuck.calls.map((c) => c.idempotencyKey),
    );
    expect(transport.calls.map((c) => c.text)).toEqual(stuck.calls.map((c) => c.text));
    const types = eventTypes(await allEvents(restarted, body.alert.alertId));
    expect(types.filter((t) => t === "alert.initial_notification_accepted")).toHaveLength(1);
  });

  it("expires queued messages that are too old to send after a restart", async () => {
    h = createPhotonHarness({ transport: new ScriptedTransport(() => new Promise(() => {})) });
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    await flush();
    h.clock.advance(10 * 60_000);
    const transport = new ScriptedTransport();
    const restarted = createPhotonHarness({
      db: h.db,
      clock: h.clock,
      transport,
      recoverOnStart: true,
    });
    const events = await waitForEvent(
      restarted,
      body.alert.alertId,
      "alert.initial_notification_failed",
    );
    expect(transport.calls).toHaveLength(0);
    expect(events.at(-1)?.payload).toEqual({ reason: "provider_unavailable", totalRecipients: 1 });
  });

  it("marks analyses interrupted by a restart as failed", async () => {
    h = createPhotonHarness({ context: { analyzeEmergencyContext: () => new Promise(() => {}) } });
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    const restarted = createPhotonHarness({ db: h.db, clock: h.clock, recoverOnStart: true });
    const events = await waitForEvent(restarted, body.alert.alertId, "context.failed");
    expect(events.at(-1)?.payload).toEqual({ reason: "timeout" });
  });
});

describe("recording link notification", () => {
  async function notifiedAlert(contacts = 2) {
    seedVerifiedContacts(h, contacts);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    await flush();
    return body.alert.alertId;
  }

  it("sends the secure link to every contact whose SOS Photon accepted", async () => {
    const transport = new ScriptedTransport((message, attempt) =>
      message.kind === "initial_sos" && message.recipient.phoneNumber === PHONES[1]
        ? permanentFailure()
        : accept()(message, attempt),
    );
    h = createPhotonHarness({ transport });
    const alertId = await notifiedAlert(3);
    const batch = await h.container.notifications.sendRecordingNotification(alertId, RECORDING_URL);
    expect(batch).toMatchObject({ kind: "recording_link", totalRecipients: 2, acceptedCount: 2 });
    const links = transport.calls.filter((c) => c.kind === "recording_link");
    expect(links.map((c) => c.recipient.phoneNumber)).toEqual([PHONES[0], PHONES[2]]);
    expect(links[0]?.text).toContain(RECORDING_URL);
    expect(links[0]?.text).toContain("HAVEN AUDIO RECORDING");
    expect((await getAlert(h, alertId)).recording.notificationAcceptedCount).toBe(2);
  });

  it("does not resend when audio completion is repeated", async () => {
    h = createPhotonHarness();
    const alertId = await notifiedAlert(2);
    const first = await h.container.notifications.sendRecordingNotification(alertId, RECORDING_URL);
    const [second, third] = await Promise.all([
      h.container.notifications.sendRecordingNotification(alertId, RECORDING_URL),
      h.container.notifications.sendRecordingNotification(alertId, RECORDING_URL),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(outbox(h).filter((r) => r.kind === "recording_link")).toHaveLength(2);
    const types = eventTypes(await allEvents(h, alertId));
    const linkEvents = (await allEvents(h, alertId)).filter(
      (e) => e.type === "notification.photon_accepted" && e.payload.kind === "recording_link",
    );
    expect(linkEvents).toHaveLength(2);
    expect(types.filter((t) => t === "alert.initial_notification_accepted")).toHaveLength(1);
  });

  it("skips contacts who opted out after the alert", async () => {
    h = createPhotonHarness();
    const alertId = await notifiedAlert(2);
    const [mom] = h.db.all<{ id: string }>("SELECT id FROM contacts ORDER BY created_at");
    setContactConsent(h.db, mom!.id, "revoked", h.clock.now());
    const batch = await h.container.notifications.sendRecordingNotification(alertId, RECORDING_URL);
    expect(batch.totalRecipients).toBe(1);
    expect(
      outbox(h)
        .filter((r) => r.kind === "recording_link")
        .map((r) => r.to_handle),
    ).toEqual([PHONES[1]]);
  });

  it("rejects links that are not absolute HTTP(S) URLs", async () => {
    h = createPhotonHarness();
    const alertId = await notifiedAlert(1);
    for (const url of ["/r/token", "javascript:alert(1)", "https://x.example/r/a b"]) {
      await expect(
        h.container.notifications.sendRecordingNotification(alertId, url),
      ).rejects.toThrow();
    }
    expect(outbox(h).filter((r) => r.kind === "recording_link")).toHaveLength(0);
  });
});

describe("context update delivery", () => {
  it("goes only to contacts whose initial SOS was accepted", async () => {
    const transport = new ScriptedTransport((message, attempt) =>
      message.kind === "initial_sos" && message.recipient.phoneNumber === PHONES[0]
        ? permanentFailure()
        : accept()(message, attempt),
    );
    h = createPhotonHarness({ transport, context: new FakeContextService(completedContext()) });
    seedVerifiedContacts(h, 2);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "context.completed");
    await vi.waitFor(() => {
      expect(transport.calls.filter((c) => c.kind === "context_update")).toHaveLength(1);
    });
    expect(transport.calls.find((c) => c.kind === "context_update")?.recipient.phoneNumber).toBe(
      PHONES[1],
    );
  });

  it("sends nothing when the result has no factual content", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 1);
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    const batch = await h.container.notifications.sendContextUpdate(
      body.alert.alertId,
      makeContextResult({ possibleContext: "The wearer was attacked" }),
    );
    expect(batch.totalRecipients).toBe(0);
    expect(outbox(h).filter((r) => r.kind === "context_update")).toHaveLength(0);
  });
});

describe("mock/live isolation", () => {
  it("never touches the network in mock mode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    h = createPhotonHarness({ context: new FakeContextService(completedContext()) });
    seedVerifiedContacts(h, 2);
    seedContact(h.db, { phoneNumber: "+14155550177", consentStatus: "pending" });
    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "context.completed");
    await h.container.notifications.sendRecordingNotification(body.alert.alertId, RECORDING_URL);
    await flush();
    expect(outbox(h).length).toBeGreaterThanOrEqual(6);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.container.config.photon.mode).toBe("mock");
  });

  it("refuses to build the live transport unless PHOTON_MODE=live", () => {
    expect(() => createLivePhotonTransport(testConfig())).toThrow(/PHOTON_MODE=live/);
  });
});
