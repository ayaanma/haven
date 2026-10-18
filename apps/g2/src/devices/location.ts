// Owner: Agent 3. Phone location (the G2 has no GPS) mapped to the shared LocationFix contract.
import type { AppLocation } from "@evenrealities/even_hub_sdk";
import {
  LocationFixSchema,
  googleMapsUrl,
  locationAgeMs,
  type LocationFix,
} from "@haven/contracts";

/** Host timestamps further in the future than this are treated as untrustworthy. */
const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * Convert an SDK fix to a LocationFix, or null when the coordinates are unusable.
 * `receivedAtMs` is used when the host omits (or sends an implausible) fix time.
 */
export function toLocationFix(
  raw: AppLocation | null | undefined,
  receivedAtMs: number,
): LocationFix | null {
  if (!raw) return null;
  const { latitude, longitude } = raw;
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const received = Math.max(0, Math.floor(receivedAtMs));
  let timestampMs = received;
  let timestampSource: LocationFix["timestampSource"] = "received";
  if (isFiniteNumber(raw.timestamp) && raw.timestamp > 0) {
    // Some hosts report seconds: use whichever reading lands closer to the receive time.
    const asMs = raw.timestamp;
    const asSeconds = raw.timestamp * 1000;
    const ms = Math.abs(asSeconds - received) < Math.abs(asMs - received) ? asSeconds : asMs;
    if (ms <= received + MAX_FUTURE_SKEW_MS) {
      timestampMs = Math.floor(ms);
      timestampSource = "host";
    }
  }

  const fix: LocationFix = {
    latitude,
    longitude,
    accuracyMeters: isFiniteNumber(raw.accuracy) && raw.accuracy >= 0 ? raw.accuracy : null,
    timestampMs,
    timestampSource,
  };
  if (isFiniteNumber(raw.speed) && raw.speed >= 0) fix.speedMps = raw.speed;
  // iOS reports -1 for an unknown heading; keep only valid compass values.
  if (isFiniteNumber(raw.heading) && raw.heading >= 0 && raw.heading <= 360)
    fix.headingDegrees = raw.heading;

  const parsed = LocationFixSchema.safeParse(fix);
  return parsed.success ? parsed.data : null;
}

/** Prefer the newer fix; on a tie prefer the more accurate one. */
export function newerFix(
  current: LocationFix | null,
  incoming: LocationFix | null,
): LocationFix | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.timestampMs > current.timestampMs) return incoming;
  if (incoming.timestampMs < current.timestampMs) return current;
  const a = current.accuracyMeters ?? Infinity;
  const b = incoming.accuracyMeters ?? Infinity;
  return b < a ? incoming : current;
}

/** Google Maps link for a fix, or null when the coordinates are out of range. */
export function createGoogleMapsLink(
  fix: Pick<LocationFix, "latitude" | "longitude"> | null,
): string | null {
  if (!fix) return null;
  const { latitude, longitude } = fix;
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return googleMapsUrl(fix);
}

export function describeLocationAge(fix: LocationFix, nowMs: number): string {
  const ageS = Math.round(locationAgeMs(fix, nowMs) / 1000);
  return ageS < 120 ? `${ageS} s old` : `${Math.round(ageS / 60)} min old`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
