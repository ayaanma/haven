// Deterministic fixture builders shared by every workspace's tests.
// Import from "@haven/contracts/testing". Never import this from production code.
import {
  ID_BODY_ALPHABET,
  ID_BODY_LENGTH,
  type AlertEvent,
  type AlertEventBody,
  type AlertRecord,
  type ContextResult,
  type EmergencyContact,
  type IdPrefix,
  type LocationFix,
  type MotionSummary,
  type SOSRequest,
  HAVEN_LLM_MODEL,
} from "../index";

export const FIXTURE_NOW_MS = Date.UTC(2026, 9, 18, 19, 30, 0);

/** A valid, deterministic prefixed ID such as `alt_0000000000000000000000001`. */
export function fixtureId(prefix: IdPrefix, n = 1): string {
  let body = "";
  let value = n;
  for (let i = 0; i < ID_BODY_LENGTH; i++) {
    body = ID_BODY_ALPHABET[value % 32] + body;
    value = Math.floor(value / 32);
  }
  return `${prefix}_${body}`;
}

/** A valid, deterministic v4-shaped UUID. */
export function fixtureUuid(n = 1): string {
  const hex = n.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

export function makeLocationFix(overrides: Partial<LocationFix> = {}): LocationFix {
  return {
    latitude: 34.068921,
    longitude: -118.445181,
    accuracyMeters: 12,
    timestampMs: FIXTURE_NOW_MS - 4_000,
    timestampSource: "host",
    ...overrides,
  };
}

export function makeMotionSummary(overrides: Partial<MotionSummary> = {}): MotionSummary {
  return {
    windowStartMs: FIXTURE_NOW_MS - 60_000,
    windowEndMs: FIXTURE_NOW_MS,
    sampleCount: 240,
    units: "sdk_raw",
    statistics: {
      magnitude: { mean: 1.02, min: 0.91, max: 3.4, stdDev: 0.21 },
      maxSampleDelta: 2.3,
      axisRange: { x: 1.8, y: 2.1, z: 0.9 },
    },
    observations: [
      {
        kind: "abrupt_change",
        atMs: FIXTURE_NOW_MS - 41_000,
        magnitude: 3.4,
        detail: "Magnitude rose to 3.3x the window mean within one sample interval",
      },
    ],
    quality: { level: "fair", effectiveSampleRateHz: 4, longestGapMs: 900, notes: [] },
    ...overrides,
  };
}

export function makeEmptyMotionSummary(): MotionSummary {
  return {
    windowStartMs: FIXTURE_NOW_MS - 60_000,
    windowEndMs: FIXTURE_NOW_MS,
    sampleCount: 0,
    units: "sdk_raw",
    statistics: null,
    observations: [],
    quality: {
      level: "none",
      effectiveSampleRateHz: null,
      longestGapMs: null,
      notes: ["No IMU samples received"],
    },
  };
}

export function makeContact(overrides: Partial<EmergencyContact> = {}): EmergencyContact {
  return {
    id: fixtureId("ctc", 1),
    displayName: "Mom",
    phoneNumber: "+14155550123",
    enabled: true,
    consent: { status: "verified", updatedAt: FIXTURE_NOW_MS - 86_400_000 },
    optInNumber: "+16283167976",
    createdAt: FIXTURE_NOW_MS - 172_800_000,
    updatedAt: FIXTURE_NOW_MS - 86_400_000,
    ...overrides,
  };
}

export function makeSOSRequest(overrides: Partial<SOSRequest> = {}): SOSRequest {
  return {
    clientAlertId: fixtureUuid(1),
    activatedAt: FIXTURE_NOW_MS - 5_000,
    location: makeLocationFix(),
    motionSummary: makeMotionSummary(),
    ...overrides,
  };
}

export function makeAlertRecord(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    alertId: fixtureId("alt", 1),
    clientAlertId: fixtureUuid(1),
    activatedAt: FIXTURE_NOW_MS - 5_000,
    createdAt: FIXTURE_NOW_MS,
    updatedAt: FIXTURE_NOW_MS,
    state: "notified",
    location: makeLocationFix(),
    recipients: [
      {
        contactId: fixtureId("ctc", 1),
        displayName: "Mom",
        status: "photon_accepted",
        updatedAt: FIXTURE_NOW_MS,
        failureCode: null,
      },
    ],
    initialAcceptedCount: 1,
    initialDeliveredCount: 0,
    totalRecipients: 1,
    aiAnalysis: { status: "pending", updatedAt: null },
    recording: {
      status: "not_started",
      recordingId: null,
      durationMs: null,
      notificationAcceptedCount: 0,
    },
    latestEventCursor: "3",
    ...overrides,
  };
}

export function makeContextResult(overrides: Partial<ContextResult> = {}): ContextResult {
  return {
    locationDescription: null,
    motionObservations: [],
    possibleContext: null,
    uncertainty: "high",
    evidenceQuality: "insufficient",
    model: HAVEN_LLM_MODEL,
    generatedAt: FIXTURE_NOW_MS,
    ...overrides,
  };
}

export function makeAlertEvent(
  body: AlertEventBody,
  overrides: { id?: number; alertId?: string; timestampMs?: number } = {},
): AlertEvent {
  return {
    id: overrides.id ?? 1,
    alertId: overrides.alertId ?? fixtureId("alt", 1),
    timestampMs: overrides.timestampMs ?? FIXTURE_NOW_MS,
    ...body,
  } as AlertEvent;
}
