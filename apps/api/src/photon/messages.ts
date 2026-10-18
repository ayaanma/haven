// Text of the three messages Haven sends to emergency contacts.
//
// Rules (docs/PRODUCT_SPEC.md, AGENTS.md invariants):
// - The SOS always says the wearer activated an emergency alert and may be in danger, and
//   asks the contact to call 911. Haven itself never contacts 911 or police and says so.
// - Only factual location data: a Google Maps link, fix age, accuracy, and fix time. A fix
//   older than LOCATION_STALE_AFTER_MS is labeled "last known"; a missing fix is stated.
// - Never claim help is coming, that a message was delivered, or that audio was reviewed.
// - AI context is hedged, separate, and cannot add incident claims (falls, attacks,
//   injuries, vehicles, medical events): lines that make them are dropped.
// Every builder is deterministic for the same input, so a retried send carries identical
// text and Photon treats it as a replay of the same idempotency key.
import {
  LOCATION_STALE_AFTER_MS,
  googleMapsUrl,
  locationAgeMs,
  type ContextResult,
  type LocationFix,
} from "@haven/contracts";

export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(ms / 86_400_000)} days`;
}

function formatAccuracy(meters: number | null): string {
  if (meters === null) return "not reported";
  if (meters < 1000) return `about ${Math.round(meters)} m`;
  return `about ${(meters / 1000).toFixed(1)} km`;
}

function locationBlock(location: LocationFix | null, activatedAt: number): string[] {
  if (!location) {
    return ["Location: unavailable. Their phone did not provide a location."];
  }
  const ageMs = locationAgeMs(location, activatedAt);
  const age =
    ageMs < 1000 ? "at the time of the alert" : `${formatDuration(ageMs)} before the alert`;
  const heading =
    ageMs > LOCATION_STALE_AFTER_MS
      ? `LAST KNOWN location (from their phone, ${age}; they may have moved since):`
      : `Location (from their phone, ${age}):`;
  const fixTime =
    location.timestampSource === "host"
      ? `Fix time: ${formatUtc(location.timestampMs)}`
      : `Fix time: not reported (their phone received it at ${formatUtc(location.timestampMs)})`;
  return [
    heading,
    googleMapsUrl(location),
    `GPS accuracy: ${formatAccuracy(location.accuracyMeters)}`,
    fixTime,
  ];
}

export interface InitialSosMessageInput {
  activatedAt: number;
  location: LocationFix | null;
}

export function buildInitialSosMessage(input: InitialSosMessageInput): string {
  // CONTRACT-PROPOSAL: a wearer display name (config or SOS request) so this can say who.
  return [
    "HAVEN SOS ALERT",
    "",
    "The person who added you as their Haven emergency contact has activated an emergency alert. They indicated they may be in danger.",
    "",
    "Please call 911 now if emergency help may be needed, and give the dispatcher the location below. Haven has not contacted 911 or the police.",
    "",
    ...locationBlock(input.location, input.activatedAt),
    "",
    `Alert activated: ${formatUtc(input.activatedAt)}`,
    "",
    "Please try to reach them, and reply to this message.",
    "This alert was sent automatically by Haven.",
  ].join("\n");
}

/**
 * Words that would turn sensor readings into an incident claim. Any AI-written line that
 * contains one is left out of the message (the structured result is still stored).
 */
const INCIDENT_CLAIM_PATTERN =
  /\b(assault\w*|attack\w*|assailant\w*|fell|fall|falls|fallen|falling|collision\w*|collid\w*|crash\w*|injur\w*|wound\w*|bleed\w*|blood\w*|medical|seizure\w*|unconscious\w*|faint\w*|kidnap\w*|abduct\w*|robb\w*|mugg\w*|stab\w*|shot|shoot\w*|gun\w*|weapon\w*|struck|hit by|accident\w*|vehicle\w*|car|cars|truck\w*|driver\w*|violen\w*|rape\w*|threat\w*|chase\w*|help is coming)\b/i;

function factual(text: string | null): string | null {
  if (text === null) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 0 && !INCIDENT_CLAIM_PATTERN.test(line) ? line : null;
}

/** The AI follow-up, or null when nothing factual remains to say. */
export function buildContextUpdateMessage(result: ContextResult): string | null {
  const location = factual(result.locationDescription);
  const motion = result.motionObservations.map(factual).filter((line) => line !== null);
  const possible = factual(result.possibleContext);
  if (!location && motion.length === 0 && !possible) return null;

  const lines = [
    "HAVEN CONTEXT UPDATE",
    "",
    "Follow-up to the Haven SOS alert. This is an automated reading of sensor data from their glasses and phone. It can be wrong, and it cannot tell what is happening.",
  ];
  if (location) lines.push("", `Location: ${location}`);
  if (motion.length > 0) lines.push("", "Motion readings:", ...motion.map((line) => `- ${line}`));
  if (possible) lines.push("", `Possible context (uncertain): ${possible}`);
  lines.push(
    "",
    result.evidenceQuality === "insufficient"
      ? "Evidence: insufficient. Haven could not tell more from the sensors."
      : `Evidence: ${result.evidenceQuality}. Uncertainty: ${result.uncertainty}.`,
    "This does not change the alert: they activated SOS and may be in danger. If you cannot reach them, call 911.",
  );
  return lines.join("\n");
}

export function buildRecordingMessage(secureUrl: string): string {
  return [
    "HAVEN AUDIO RECORDING",
    "",
    "Follow-up to the Haven SOS alert. Audio recorded on their glasses after the alert is available here:",
    secureUrl,
    "",
    "It may contain information about their safety. Haven has not listened to or reviewed it.",
  ].join("\n");
}
