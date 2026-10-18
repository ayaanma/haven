import { afterEach, describe, expect, it } from "vitest";
import { ContactsResponseSchema, ROUTES } from "@haven/contracts";
import { seedContact } from "../testing";
import {
  MOCK_WEBHOOK_SECRET,
  buildMessageReceivedEvent,
  buildMessageStatusEvent,
  photonStyleId,
  signedWebhookRequest,
} from "./mock-webhook";
import {
  PHONES,
  ScriptedTransport,
  allEvents,
  createPhotonHarness,
  eventTypes,
  flush,
  getAlert,
  postSOS,
  postWebhook,
  seedVerifiedContacts,
  sosRequest,
  waitForEvent,
  type PhotonHarness,
} from "./testing";

let h: PhotonHarness;
afterEach(() => h?.close());

const LIVE_SECRET = `whsec_${Buffer.from("live-secret-0123456789abcdef0123").toString("base64")}`;
const LIVE_ENV = {
  PHOTON_MODE: "live",
  PHOTON_API_KEY: "pho_sk_test_key",
  PHOTON_PROJECT_ID: "pho_prj_01k0000000000000000000000a",
  PHOTON_AGENT_USER_ID: "pho_usr_01k0000000000000000000000a",
  PHOTON_WEBHOOK_SECRET: LIVE_SECRET,
  PUBLIC_BASE_URL: "https://haven.example",
};

function reply(
  from: string,
  text: string,
  extra: Partial<Parameters<typeof buildMessageReceivedEvent>[0]> = {},
) {
  return buildMessageReceivedEvent({
    fromHandle: from,
    text,
    atMs: h.clock.now() - 2_000,
    ...extra,
  });
}

async function status(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { status: string }).status;
}

async function activeAlert(contacts = 2): Promise<string> {
  seedVerifiedContacts(h, contacts);
  const { body } = await postSOS(h);
  await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
  await flush();
  return body.alert.alertId;
}

function receipts(): number {
  return h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_receipts")?.n ?? -1;
}

describe("contact replies", () => {
  it("records a verified contact's reply on the active alert, verbatim", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert();
    const event = reply("+1 (415) 555-0101", "I'm calling 911 now");
    expect(await status(await postWebhook(h, event))).toBe("processed");

    const events = await allEvents(h, alertId);
    const responded = events.filter((e) => e.type === "contact.responded");
    expect(responded).toHaveLength(1);
    expect(responded[0]?.payload).toEqual({
      contactId: expect.stringMatching(/^ctc_/),
      displayName: "Mom",
      text: "I'm calling 911 now",
      receivedAt: h.clock.now() - 2_000,
    });
    const stored = h.db.get<{ alert_id: string; contact_id: string; text: string }>(
      "SELECT alert_id, contact_id, text FROM inbound_messages",
    );
    expect(stored).toMatchObject({ alert_id: alertId, text: "I'm calling 911 now" });
  });

  it("routes a threaded reply to the alert it answers", async () => {
    h = createPhotonHarness();
    const first = await activeAlert(1);
    h.clock.advance(60_000);
    const second = (await postSOS(h, sosRequest(2))).body.alert.alertId;
    await waitForEvent(h, second, "alert.initial_notification_accepted");
    const parent = h.db.get<{ photon_message_id: string }>(
      "SELECT photon_message_id FROM alert_notifications WHERE alert_id = ?",
      first,
    )!.photon_message_id;

    await postWebhook(h, reply(PHONES[0], "Saw the first one", { parentMessageId: parent }));
    await postWebhook(h, reply(PHONES[0], "On my way"));
    const textsFor = async (alertId: string) =>
      (await allEvents(h, alertId))
        .filter((e) => e.type === "contact.responded")
        .map((e) => (e.payload as { text: string }).text);
    expect(await textsFor(first)).toEqual(["Saw the first one"]);
    expect(await textsFor(second)).toEqual(["On my way"]);
  });

  it("strips control characters and limits length without rewriting the text", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    await postWebhook(h, reply(PHONES[0], "Where are you?\r\n\u0007Answer me\u0000"));
    await postWebhook(h, reply(PHONES[0], "x".repeat(800)));
    const texts = (await allEvents(h, alertId))
      .filter((e) => e.type === "contact.responded")
      .map((e) => (e.payload as { text: string }).text);
    expect(texts[0]).toBe("Where are you?\nAnswer me");
    expect(texts[1]).toHaveLength(500);
    expect(texts[1]?.endsWith("…")).toBe(true);
  });

  it("processes a redelivered event once", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    const event = reply(PHONES[0], "Calling you");
    expect(await status(await postWebhook(h, event))).toBe("processed");
    expect(await status(await postWebhook(h, event))).toBe("duplicate");
    // Same Photon message under a new event ID (for example after a destination change).
    const again = { ...event, id: photonStyleId("evt") };
    expect(await status(await postWebhook(h, again))).toBe("duplicate");
    const types = eventTypes(await allEvents(h, alertId));
    expect(types.filter((t) => t === "contact.responded")).toHaveLength(1);
  });

  it("quarantines messages from unknown senders", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    expect(await status(await postWebhook(h, reply("+14155550999", "who is this?")))).toBe(
      "ignored",
    );
    expect(await status(await postWebhook(h, reply("someone@example.com", "hi")))).toBe("ignored");
    const quarantined = h.db.all<{ contact_id: string | null; alert_id: string | null }>(
      "SELECT contact_id, alert_id FROM inbound_messages",
    );
    expect(quarantined).toEqual([
      { contact_id: null, alert_id: null },
      { contact_id: null, alert_id: null },
    ]);
    expect(eventTypes(await allEvents(h, alertId))).not.toContain("contact.responded");
  });

  it("ignores a verified contact's message when no alert is active", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    h.clock.advance(25 * 60 * 60_000);
    expect(await status(await postWebhook(h, reply(PHONES[0], "late reply")))).toBe("ignored");
    expect(eventTypes(await allEvents(h, alertId))).not.toContain("contact.responded");
  });

  it("ignores Haven's own outbound messages", async () => {
    h = createPhotonHarness({ env: { PHOTON_AGENT_USER_ID: LIVE_ENV.PHOTON_AGENT_USER_ID } });
    const alertId = await activeAlert(1);
    const echo = reply(PHONES[0], "HAVEN SOS ALERT", {
      senderUserId: LIVE_ENV.PHOTON_AGENT_USER_ID,
    });
    expect(await status(await postWebhook(h, echo))).toBe("ignored");
    expect(eventTypes(await allEvents(h, alertId))).not.toContain("contact.responded");
  });
});

describe("webhook authentication", () => {
  type Event = ReturnType<typeof reply>;
  it.each([
    [
      "no signature headers",
      (): Record<string, string> => ({ "content-type": "application/json" }),
    ],
    [
      "a wrong secret",
      (event: Event) =>
        signedWebhookRequest(event, { secret: LIVE_SECRET, timestampMs: h.clock.now() }).headers,
    ],
    [
      "a replayed timestamp",
      (event: Event) =>
        signedWebhookRequest(event, { timestampMs: h.clock.now() - 10 * 60_000 }).headers,
    ],
  ])("rejects %s with 401 and changes nothing", async (_name, headersFor) => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    const event = reply(PHONES[0], "fake: help is coming");
    const res = await h.request(ROUTES.photonWebhooks, {
      method: "POST",
      headers: headersFor(event),
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(401);
    expect(receipts()).toBe(0);
    expect(eventTypes(await allEvents(h, alertId))).not.toContain("contact.responded");
  });

  it("rejects a body altered after signing", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    const res = await postWebhook(h, reply(PHONES[0], "ok"), {
      tamper: (body) => body.replace('"ok"', '"help is coming"'),
    });
    expect(res.status).toBe(401);
    expect(receipts()).toBe(0);
    expect(eventTypes(await allEvents(h, alertId))).not.toContain("contact.responded");
  });

  it("rejects signed bodies that are not Photon events", async () => {
    h = createPhotonHarness();
    const res = await postWebhook(h, { nope: true } as never);
    expect(res.status).toBe(400);
  });

  it("never accepts the mock secret in live mode", async () => {
    h = createPhotonHarness({ env: LIVE_ENV, transport: new ScriptedTransport() });
    seedVerifiedContacts(h, 1);
    const event = reply(PHONES[0], "hi", { projectId: LIVE_ENV.PHOTON_PROJECT_ID });
    expect((await postWebhook(h, event, { secret: MOCK_WEBHOOK_SECRET })).status).toBe(401);
    expect(await status(await postWebhook(h, event, { secret: LIVE_SECRET }))).toBe("ignored");
  });

  it("ignores events for another Photon project", async () => {
    h = createPhotonHarness({ env: LIVE_ENV, transport: new ScriptedTransport() });
    seedContact(h.db, { phoneNumber: PHONES[0], consentStatus: "pending" });
    const event = reply(PHONES[0], "yes", { projectId: photonStyleId("prj") });
    expect(await status(await postWebhook(h, event, { secret: LIVE_SECRET }))).toBe("ignored");
    expect(h.db.get<{ consent_status: string }>("SELECT consent_status FROM contacts")).toEqual({
      consent_status: "pending",
    });
  });
});

describe("consent", () => {
  async function consentOf(phoneNumber: string) {
    const res = await h.json("GET", ROUTES.contacts);
    return ContactsResponseSchema.parse(await res.json()).contacts.find(
      (c) => c.phoneNumber === phoneNumber,
    )?.consent;
  }

  it("verifies a pending contact on their first message", async () => {
    h = createPhotonHarness();
    seedContact(h.db, { phoneNumber: PHONES[0], consentStatus: "pending", now: 1 });
    expect(await status(await postWebhook(h, reply(PHONES[0], "Yes, I'll be your contact")))).toBe(
      "processed",
    );
    expect(await consentOf(PHONES[0])).toEqual({ status: "verified", updatedAt: h.clock.now() });
  });

  it("revokes on STOP, excludes the contact from later alerts, and re-verifies on START", async () => {
    h = createPhotonHarness();
    seedVerifiedContacts(h, 2);
    expect(await status(await postWebhook(h, reply(PHONES[0], " stop. ")))).toBe("processed");
    expect((await consentOf(PHONES[0]))?.status).toBe("revoked");

    const { body } = await postSOS(h);
    expect(body.alert.recipients.map((r) => r.displayName)).toEqual(["Dad"]);

    expect(await status(await postWebhook(h, reply(PHONES[0], "hello?")))).toBe("ignored");
    expect((await consentOf(PHONES[0]))?.status).toBe("revoked");
    expect(await status(await postWebhook(h, reply(PHONES[0], "START")))).toBe("processed");
    expect((await consentOf(PHONES[0]))?.status).toBe("verified");
  });

  it("does not treat ambiguous words as an opt-out during an alert", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(1);
    expect(await status(await postWebhook(h, reply(PHONES[0], "cancel")))).toBe("processed");
    expect((await consentOf(PHONES[0]))?.status).toBe("verified");
    expect(eventTypes(await allEvents(h, alertId))).toContain("contact.responded");
  });
});

describe("delivery status events", () => {
  async function sentMessageId(alertId: string, phone: string): Promise<string> {
    return h.db.get<{ photon_message_id: string }>(
      `SELECT photon_message_id FROM alert_notifications
       WHERE alert_id = ? AND contact_phone_number = ? AND kind = 'initial_sos'`,
      alertId,
      phone,
    )!.photon_message_id;
  }

  it("tracks delivered, delivery-unconfirmed, and failed per recipient", async () => {
    h = createPhotonHarness();
    const alertId = await activeAlert(3);
    const at = h.clock.now();
    const send = async (
      type: Parameters<typeof buildMessageStatusEvent>[0]["type"],
      phone: string,
    ) =>
      status(
        await postWebhook(
          h,
          buildMessageStatusEvent({
            type,
            messageId: await sentMessageId(alertId, phone),
            atMs: at,
            ...(type === "message.failed" ? { failureCode: "recipient_unreachable" } : {}),
          }),
        ),
      );

    expect(await send("message.delivered", PHONES[0])).toBe("processed");
    expect(await send("message.accepted", PHONES[1])).toBe("processed");
    expect(await send("message.failed", PHONES[2])).toBe("processed");
    // Out of order: a late `dispatched` and a second terminal status change nothing.
    await send("message.dispatched", PHONES[0]);
    await send("message.failed", PHONES[0]);

    const alert = await getAlert(h, alertId);
    expect(alert.recipients.map((r) => [r.status, r.failureCode])).toEqual([
      ["delivered", null],
      ["delivery_unconfirmed", null],
      ["failed", "recipient_unreachable"],
    ]);
    expect(alert).toMatchObject({
      state: "notified",
      initialAcceptedCount: 2,
      initialDeliveredCount: 1,
    });
    const types = eventTypes(await allEvents(h, alertId));
    expect(types.filter((t) => t === "notification.delivered")).toHaveLength(1);
    expect(types.filter((t) => t === "notification.delivery_unconfirmed")).toHaveLength(1);
    expect(types.filter((t) => t === "notification.failed")).toHaveLength(1);
  });

  it("ignores status events for messages Haven did not send", async () => {
    h = createPhotonHarness();
    await activeAlert(1);
    const event = buildMessageStatusEvent({
      type: "message.delivered",
      messageId: photonStyleId("msg"),
      atMs: h.clock.now(),
    });
    expect(await status(await postWebhook(h, event))).toBe("ignored");
  });
});
