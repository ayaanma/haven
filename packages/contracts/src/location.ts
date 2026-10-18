import { z } from "zod";
import { TimestampMsSchema } from "./common";

/**
 * Where a fix's `timestampMs` came from.
 * - `host`: the phone's location provider reported the fix time (SDK `AppLocation.timestamp`).
 * - `received`: the host omitted it, so the G2 app used the time the WebView received the fix.
 *   Messages must not present a `received` time as the exact moment of the fix.
 */
export const LocationTimestampSourceSchema = z.enum(["host", "received"]);
export type LocationTimestampSource = z.infer<typeof LocationTimestampSourceSchema>;

/**
 * A phone GPS fix obtained through the Even Hub SDK (`getAppLocation` or
 * `onAppLocationChanged`). The G2 glasses have no GPS; location always comes
 * from the phone running the Even Realities app.
 */
export const LocationFixSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Horizontal accuracy radius in meters, or null when the host did not report it. */
  accuracyMeters: z.number().nonnegative().nullable(),
  timestampMs: TimestampMsSchema,
  timestampSource: LocationTimestampSourceSchema,
  speedMps: z.number().nonnegative().optional(),
  headingDegrees: z.number().min(0).max(360).optional(),
});
export type LocationFix = z.infer<typeof LocationFixSchema>;

/** A fix older than this at SOS time must be described to contacts as "last known". */
export const LOCATION_STALE_AFTER_MS = 2 * 60_000;

/**
 * Google Maps link for a fix, using the documented Maps URLs API
 * (https://developers.google.com/maps/documentation/urls/get-started).
 */
export function googleMapsUrl(fix: Pick<LocationFix, "latitude" | "longitude">): string {
  const query = `${fix.latitude.toFixed(6)},${fix.longitude.toFixed(6)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Age of a fix relative to `nowMs`, never negative (clock skew is clamped to 0). */
export function locationAgeMs(fix: Pick<LocationFix, "timestampMs">, nowMs: number): number {
  return Math.max(0, nowMs - fix.timestampMs);
}
