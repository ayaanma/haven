import { describe, expect, it } from "vitest";
import {
  AlertEventSchema,
  AlertEventsPageSchema,
  AlertRecordSchema,
  ApiErrorBodySchema,
  ContextAnalysisOutcomeSchema,
  CreateSessionResponseSchema,
  E164PhoneNumberSchema,
  EmergencyContactSchema,
  GetAlertEventsQuerySchema,
  HAVEN_CLIENT_STATES,
  HUD_COPY,
  LocationFixSchema,
  MotionSummarySchema,
  SINGLE_PRESS_BEHAVIOR,
  SOSRequestSchema,
  SOS_COUNTDOWN_MS,
  SaveContactsRequestSchema,
  UploadAudioChunkQuerySchema,
  countdownSecondsRemaining,
  googleMapsUrl,
  isAcceptedNotificationStatus,
  isAlertEventOfType,
  isCancelPressInTime,
  isContactEligibleForAlerts,
  idPattern,
} from "./index";
import {
  fixtureId,
  fixtureUuid,
  makeAlertEvent,
  makeAlertRecord,
  makeContact,
  makeContextResult,
  makeEmptyMotionSummary,
  makeLocationFix,
  makeMotionSummary,
  makeSOSRequest,
} from "./testing";

describe("identifiers", () => {
  it("fixture IDs match the server ID pattern", () => {
    expect(fixtureId("alt", 7)).toMatch(idPattern("alt"));
    expect(fixtureId("ctc", 123_456)).toMatch(idPattern("ctc"));
  });

  it("accepts E.164 and rejects local formats", () => {
    expect(E164PhoneNumberSchema.safeParse("+14155550123").success).toBe(true);
    for (const bad of ["4155550123", "+0155550123", "+1 415 555 0123", "+1234567890123456"]) {
      expect(E164PhoneNumberSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("location", () => {
  it("validates a fix and rejects impossible coordinates", () => {
    expect(LocationFixSchema.parse(makeLocationFix())).toBeTruthy();
    expect(LocationFixSchema.safeParse(makeLocationFix({ latitude: 91 })).success).toBe(false);
    expect(LocationFixSchema.safeParse(makeLocationFix({ accuracyMeters: -1 })).success).toBe(
      false,
    );
  });

  it("allows unknown accuracy as null, never as a missing key", () => {
    expect(LocationFixSchema.safeParse(makeLocationFix({ accuracyMeters: null })).success).toBe(
      true,
    );
    const { accuracyMeters: _omitted, ...withoutAccuracy } = makeLocationFix();
    expect(LocationFixSchema.safeParse(withoutAccuracy).success).toBe(false);
  });

  it("builds a Google Maps search URL", () => {
    expect(googleMapsUrl({ latitude: 34.0689213, longitude: -118.4451811 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=34.068921%2C-118.445181",
    );
  });
});

describe("motion", () => {
  it("accepts populated and empty summaries", () => {
    expect(MotionSummarySchema.safeParse(makeMotionSummary()).success).toBe(true);
    expect(MotionSummarySchema.safeParse(makeEmptyMotionSummary()).success).toBe(true);
  });

  it("requires statistics to be null exactly when there are no samples", () => {
    expect(MotionSummarySchema.safeParse(makeMotionSummary({ sampleCount: 0 })).success).toBe(
      false,
    );
    expect(
      MotionSummarySchema.safeParse({ ...makeEmptyMotionSummary(), sampleCount: 5 }).success,
    ).toBe(false);
  });

  it("rejects inverted windows", () => {
    const summary = makeMotionSummary({ windowStartMs: 10, windowEndMs: 5 });
    expect(MotionSummarySchema.safeParse(summary).success).toBe(false);
  });
});

describe("contacts", () => {
  it("only enabled, verified contacts are eligible", () => {
    expect(isContactEligibleForAlerts(makeContact())).toBe(true);
    expect(isContactEligibleForAlerts(makeContact({ enabled: false }))).toBe(false);
    for (const status of ["pending", "revoked"] as const) {
      const contact = makeContact({ consent: { status, updatedAt: null } });
      expect(isContactEligibleForAlerts(contact)).toBe(false);
    }
  });

  it("rejects control characters in display names", () => {
    expect(
      EmergencyContactSchema.safeParse(makeContact({ displayName: "Mo\u0007m" })).success,
    ).toBe(false);
  });

  it("rejects duplicate phone numbers and too many contacts on save", () => {
    const input = { displayName: "A", phoneNumber: "+14155550123", enabled: true };
    expect(SaveContactsRequestSchema.safeParse({ contacts: [input, input] }).success).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...input,
      phoneNumber: `+1415555012${i}`,
    }));
    expect(SaveContactsRequestSchema.safeParse({ contacts: six }).success).toBe(false);
  });

  it("does not let clients set consent", () => {
    const withConsent = {
      contacts: [
        {
          displayName: "A",
          phoneNumber: "+14155550123",
          enabled: true,
          consent: { status: "verified" },
        },
      ],
    };
    expect(SaveContactsRequestSchema.safeParse(withConsent).success).toBe(false);
  });
});

describe("SOS request", () => {
  it("accepts a full request and a request with no sensor data", () => {
    expect(SOSRequestSchema.safeParse(makeSOSRequest()).success).toBe(true);
    const minimal = { clientAlertId: fixtureUuid(2), activatedAt: 1 };
    expect(SOSRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it("requires a UUID idempotency key and rejects unknown fields", () => {
    expect(SOSRequestSchema.safeParse(makeSOSRequest({ clientAlertId: "abc" })).success).toBe(
      false,
    );
    expect(SOSRequestSchema.safeParse({ ...makeSOSRequest(), callPolice: true }).success).toBe(
      false,
    );
  });
});

describe("alert record", () => {
  it("validates the fixture", () => {
    expect(AlertRecordSchema.parse(makeAlertRecord())).toBeTruthy();
  });

  it("keeps counts consistent with recipients", () => {
    expect(AlertRecordSchema.safeParse(makeAlertRecord({ totalRecipients: 2 })).success).toBe(
      false,
    );
    expect(AlertRecordSchema.safeParse(makeAlertRecord({ initialDeliveredCount: 2 })).success).toBe(
      false,
    );
  });

  it("treats Photon acceptance and delivery as distinct statuses", () => {
    expect(isAcceptedNotificationStatus("photon_accepted")).toBe(true);
    expect(isAcceptedNotificationStatus("delivery_unconfirmed")).toBe(true);
    expect(isAcceptedNotificationStatus("delivered")).toBe(true);
    expect(isAcceptedNotificationStatus("queued")).toBe(false);
    expect(isAcceptedNotificationStatus("failed")).toBe(false);
  });
});

describe("events", () => {
  it("parses a typed event and narrows it", () => {
    const event = AlertEventSchema.parse(
      makeAlertEvent(
        {
          type: "contact.responded",
          payload: {
            contactId: fixtureId("ctc", 1),
            displayName: "Dad",
            text: "I'm calling 911.",
            receivedAt: 1,
          },
        },
        { id: 9 },
      ),
    );
    expect(isAlertEventOfType(event, "contact.responded")).toBe(true);
    if (isAlertEventOfType(event, "contact.responded")) {
      expect(event.payload.displayName).toBe("Dad");
    }
  });

  it("rejects a payload that does not match its type", () => {
    const bad = {
      id: 1,
      alertId: fixtureId("alt", 1),
      timestampMs: 1,
      type: "alert.initial_notification_accepted",
      payload: { acceptedCount: 0, totalRecipients: 1 },
    };
    expect(AlertEventSchema.safeParse(bad).success).toBe(false);
    expect(AlertEventSchema.safeParse({ ...bad, type: "help.is.coming" }).success).toBe(false);
  });

  it("defaults and bounds the events query", () => {
    expect(GetAlertEventsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(GetAlertEventsQuerySchema.parse({ cursor: "12", limit: "5" })).toEqual({
      cursor: "12",
      limit: 5,
    });
    expect(GetAlertEventsQuerySchema.safeParse({ limit: "1000" }).success).toBe(false);
    expect(GetAlertEventsQuerySchema.safeParse({ cursor: "-1" }).success).toBe(false);
  });

  it("validates an events page", () => {
    const page = {
      events: [
        makeAlertEvent({
          type: "context.insufficient_information",
          payload: { result: makeContextResult() },
        }),
      ],
      nextCursor: "1",
      hasMore: false,
    };
    expect(AlertEventsPageSchema.safeParse(page).success).toBe(true);
  });
});

describe("context outcome", () => {
  it("is a discriminated union on status", () => {
    expect(
      ContextAnalysisOutcomeSchema.safeParse({ status: "failed", reason: "timeout" }).success,
    ).toBe(true);
    expect(ContextAnalysisOutcomeSchema.safeParse({ status: "completed" }).success).toBe(false);
  });
});

describe("audio chunk query", () => {
  it("coerces the index from the query string", () => {
    const parsed = UploadAudioChunkQuerySchema.parse({
      recordingId: fixtureUuid(3),
      index: "4",
      sha256: "a".repeat(64),
    });
    expect(parsed.index).toBe(4);
  });
});

describe("auth and errors", () => {
  it("validates session responses and error bodies", () => {
    expect(
      CreateSessionResponseSchema.safeParse({
        sessionToken: `hvn_${"A".repeat(43)}`,
        tokenType: "Bearer",
        expiresAt: 1,
        scopes: ["alerts:write"],
      }).success,
    ).toBe(true);
    expect(
      ApiErrorBodySchema.safeParse({
        error: { code: "not_implemented", message: "x", requestId: "r" },
      }).success,
    ).toBe(true);
  });
});

describe("G2 single-press contract", () => {
  it("defines behavior for every state", () => {
    for (const state of HAVEN_CLIENT_STATES) {
      expect(SINGLE_PRESS_BEHAVIOR[state]).toBeDefined();
    }
  });

  it("matches the product table exactly", () => {
    expect(SINGLE_PRESS_BEHAVIOR).toEqual({
      IDLE: "start_countdown",
      COUNTDOWN: "cancel_countdown",
      SUBMITTING_SOS: "ignore",
      WAITING_FOR_PHOTON: "ignore",
      RECORDING: "stop_and_send_recording",
      UPLOADING_AUDIO: "ignore",
      ACTIVE_ALERT: "ignore",
      ERROR: "ignore_until_reset",
    });
  });

  it("only IDLE can start an alert, and only RECORDING submits audio", () => {
    const starters = HAVEN_CLIENT_STATES.filter(
      (s) => SINGLE_PRESS_BEHAVIOR[s] === "start_countdown",
    );
    expect(starters).toEqual(["IDLE"]);
    const submitters = HAVEN_CLIENT_STATES.filter(
      (s) => SINGLE_PRESS_BEHAVIOR[s] === "stop_and_send_recording",
    );
    expect(submitters).toEqual(["RECORDING"]);
  });

  it("counts a cancel press by when it happened, not when it resolved", () => {
    const deadline = 1_000 + SOS_COUNTDOWN_MS;
    expect(isCancelPressInTime(deadline - 1, deadline)).toBe(true);
    expect(isCancelPressInTime(deadline, deadline)).toBe(false);
  });

  it("shows 5..1 then 0", () => {
    const deadline = SOS_COUNTDOWN_MS;
    expect(countdownSecondsRemaining(0, deadline)).toBe(5);
    expect(countdownSecondsRemaining(1, deadline)).toBe(5);
    expect(countdownSecondsRemaining(4_001, deadline)).toBe(1);
    expect(countdownSecondsRemaining(5_000, deadline)).toBe(0);
    expect(countdownSecondsRemaining(9_000, deadline)).toBe(0);
  });

  it("pins the required HUD copy", () => {
    expect(HUD_COPY).toEqual({
      countdownQuestion: "Are you in danger?",
      countdownCancelHint: "If not, click to disable.",
      countdownSending: "Sending message in...",
      sosSent: "SOS sent",
      recording: "Recording...",
      recordingHint: "Click to send audio",
    });
  });
});
