import { describe, expect, it } from "vitest";
import { LOCATION_STALE_AFTER_MS } from "@haven/contracts";
import { FIXTURE_NOW_MS, makeContextResult, makeLocationFix } from "@haven/contracts/testing";
import {
  buildContextUpdateMessage,
  buildInitialSosMessage,
  buildRecordingMessage,
} from "./messages";

const activatedAt = FIXTURE_NOW_MS;
/** Phrases Haven must never send: unverified reassurance or claims it cannot know. */
const FORBIDDEN = [
  /help is (coming|on the way)/i,
  /police (are|have been) (notified|called)/i,
  /delivered/i,
];

describe("initial SOS message", () => {
  it("states the danger alert, asks for 911, and gives factual location data", () => {
    const text = buildInitialSosMessage({
      activatedAt,
      location: makeLocationFix({ timestampMs: activatedAt - 4_000, accuracyMeters: 12.4 }),
    });
    expect(text.startsWith("HAVEN SOS ALERT\n")).toBe(true);
    expect(text).toContain("has activated an emergency alert");
    expect(text).toContain("may be in danger");
    expect(text).toContain("call 911");
    expect(text).toContain("Haven has not contacted 911 or the police");
    expect(text).toContain(
      "https://www.google.com/maps/search/?api=1&query=34.068921%2C-118.445181",
    );
    expect(text).toContain("Location (from their phone, 4 seconds before the alert):");
    expect(text).toContain("GPS accuracy: about 12 m");
    expect(text).toContain("Fix time: 2026-10-18 19:29:56 UTC");
    expect(text).toContain("Alert activated: 2026-10-18 19:30:00 UTC");
    expect(text).toContain("reply to this message");
    expect(text).not.toContain("LAST KNOWN");
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
  });

  it("names the wearer when HAVEN_WEARER_NAME is configured", () => {
    const text = buildInitialSosMessage({ activatedAt, location: null, wearerName: "Jaden" });
    expect(text).toContain(
      "Jaden has activated a Haven emergency alert. They indicated they may be in danger.",
    );
  });

  it("labels a stale fix as the last known location", () => {
    const text = buildInitialSosMessage({
      activatedAt,
      location: makeLocationFix({ timestampMs: activatedAt - LOCATION_STALE_AFTER_MS - 60_000 }),
    });
    expect(text).toContain(
      "LAST KNOWN location (from their phone, 3 minutes before the alert; they may have moved since):",
    );
  });

  it("says plainly when there is no location and never invents one", () => {
    const text = buildInitialSosMessage({ activatedAt, location: null });
    expect(text).toContain("Location: unavailable. Their phone did not provide a location.");
    expect(text).not.toContain("google.com/maps");
    expect(text).toContain("call 911");
  });

  it("reports missing accuracy and an unreported fix time honestly", () => {
    const text = buildInitialSosMessage({
      activatedAt,
      location: makeLocationFix({ accuracyMeters: null, timestampSource: "received" }),
    });
    expect(text).toContain("GPS accuracy: not reported");
    expect(text).toContain("Fix time: not reported (their phone received it at");
  });

  it("is deterministic, so a retried send is an exact replay", () => {
    const input = { activatedAt, location: makeLocationFix() };
    expect(buildInitialSosMessage(input)).toBe(buildInitialSosMessage(input));
  });
});

describe("context update message", () => {
  it("is separate, hedged, and keeps the alert's urgency", () => {
    const text = buildContextUpdateMessage(
      makeContextResult({
        locationDescription: "Near a roadway (approximate)",
        motionObservations: ["Several abrupt changes in head movement before the alert"],
        possibleContext: "The available information cannot determine what caused the movement",
        evidenceQuality: "limited",
        uncertainty: "high",
      }),
    );
    expect(text).not.toBeNull();
    expect(text!.startsWith("HAVEN CONTEXT UPDATE\n")).toBe(true);
    expect(text).toContain("It can be wrong, and it cannot tell what is happening.");
    expect(text).toContain("Location: Near a roadway (approximate)");
    expect(text).toContain("- Several abrupt changes in head movement before the alert");
    expect(text).toContain("Possible context (uncertain):");
    expect(text).toContain("Evidence: limited. Uncertainty: high.");
    expect(text).toContain("they activated SOS and may be in danger");
  });

  it("drops AI lines that claim an incident", () => {
    const text = buildContextUpdateMessage(
      makeContextResult({
        locationDescription: "Near Westwood Blvd",
        motionObservations: ["The wearer fell to the ground", "Abrupt head movement"],
        possibleContext: "Likely an assault or a car accident",
        evidenceQuality: "adequate",
      }),
    );
    expect(text).toContain("- Abrupt head movement");
    expect(text).not.toMatch(/fell|assault|car|accident/i);
  });

  it("returns null when nothing factual is left to send", () => {
    expect(buildContextUpdateMessage(makeContextResult())).toBeNull();
    expect(
      buildContextUpdateMessage(
        makeContextResult({ possibleContext: "Possible medical emergency" }),
      ),
    ).toBeNull();
  });

  it("says so plainly when the evidence is insufficient", () => {
    const text = buildContextUpdateMessage(
      makeContextResult({ motionObservations: ["Only 3 motion samples were received"] }),
    );
    expect(text).toContain("Evidence: insufficient. Haven could not tell more from the sensors.");
  });
});

describe("recording message", () => {
  it("links the recording without describing or claiming to have heard it", () => {
    const url = "https://haven.example/r/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const text = buildRecordingMessage(url);
    expect(text.startsWith("HAVEN AUDIO RECORDING\n")).toBe(true);
    expect(text).toContain(`\n${url}\n`);
    expect(text).toContain("Haven has not listened to or reviewed it.");
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
  });
});
