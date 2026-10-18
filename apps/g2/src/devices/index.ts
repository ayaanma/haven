// Owner: Agent 3. G2 sensor collection: phone location cache + G2 IMU ring buffer.
//
// - Location: startAppLocationUpdates + onAppLocationChanged keep the latest phone fix;
//   getAppLocation is a bounded fallback inside getEmergencySnapshot.
// - Motion: imuControl(true, pace) and sysEvent.imuData (eventType IMU_DATA_REPORT = 8)
//   feed a bounded MotionBuffer, summarized on demand (raw SDK units).
// - Android may suspend the WebView: sensors are re-armed on FOREGROUND_ENTER_EVENT.
// - getEmergencySnapshot never rejects and resolves within EMERGENCY_SNAPSHOT_TIMEOUT_MS.
// Never logs coordinates or raw samples.
import {
  AppLocationAccuracy,
  ImuReportPace,
  OsEventTypeList,
  type AppLocation,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import {
  EmergencySensorSnapshotSchema,
  LOCATION_STALE_AFTER_MS,
  locationAgeMs,
  type EmergencySensorSnapshot,
  type LocationFix,
} from "@haven/contracts";
import {
  EMERGENCY_SNAPSHOT_TIMEOUT_MS,
  type DeviceServiceDeps,
  type HavenDeviceService,
} from "../core/interfaces";
import { describeLocationAge, newerFix, toLocationFix } from "./location";
import { MotionBuffer, summarizeMotion } from "./motion";

export { createGoogleMapsLink, toLocationFix } from "./location";
export { MotionBuffer, summarizeMotion } from "./motion";

/** Report pace requested from the glasses. Real rate per code is unverified (HARDWARE_TEST_PLAN H8). */
export const IMU_PACE = ImuReportPace.P100;
/** Time allowed for a fresh host fix inside the snapshot, leaving margin under the 1.5 s cap. */
export const SNAPSHOT_LOCATION_BUDGET_MS = EMERGENCY_SNAPSHOT_TIMEOUT_MS - 300;
/** A cached fix younger than this is used without asking the host for a new one. */
export const FRESH_ENOUGH_MS = 15_000;
const LOCATION_UPDATE_OPTIONS = { accuracy: AppLocationAccuracy.High, intervalMs: 5_000 };

export function createDeviceService(deps: DeviceServiceDeps): HavenDeviceService {
  const { bridge, scheduler, log } = deps;
  const motion = new MotionBuffer();

  let started = false;
  let starting: Promise<void> | null = null;
  let unsubscribeHub: (() => void) | null = null;
  let unsubscribeLocation: (() => void) | null = null;
  let latestFix: LocationFix | null = null;
  let imuArmed = false;
  let locationArmed = false;
  let locationUnavailable = false;
  let refreshInFlight: Promise<LocationFix | null> | null = null;

  const now = () => Math.max(0, Math.floor(scheduler.now()));

  const acceptFix = (raw: AppLocation | null | undefined): LocationFix | null => {
    const fix = toLocationFix(raw, now());
    if (fix) {
      latestFix = newerFix(latestFix, fix);
      locationUnavailable = false;
    }
    return fix;
  };

  const onHubEvent = (event: EvenHubEvent) => {
    const sys = event.sysEvent;
    if (sys && (sys.imuData || sys.eventType === OsEventTypeList.IMU_DATA_REPORT)) {
      const d = sys.imuData;
      if (d) motion.add(now(), d.x, d.y, d.z);
      return;
    }
    const type = sys?.eventType ?? event.textEvent?.eventType;
    if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT && started) {
      log.info("foreground entered; re-arming sensors");
      void arm();
    }
  };

  async function armImu(): Promise<void> {
    try {
      imuArmed = await bridge.imuControl(true, IMU_PACE);
      if (!imuArmed) log.warn("imuControl(true) returned false");
    } catch (error) {
      imuArmed = false;
      log.warn("imuControl failed", { error: String(error) });
    }
  }

  async function armLocation(): Promise<void> {
    try {
      locationArmed = await bridge.startAppLocationUpdates(LOCATION_UPDATE_OPTIONS);
      if (!locationArmed) log.warn("startAppLocationUpdates returned false");
    } catch (error) {
      locationArmed = false;
      log.warn("startAppLocationUpdates failed", { error: String(error) });
    }
    // Seed the cache in the background; startup never waits on GPS.
    void refreshLocation(5_000);
  }

  async function arm(): Promise<void> {
    await Promise.all([armImu(), armLocation()]);
  }

  /** One host location request at a time; concurrent callers share it. Never rejects. */
  function refreshLocation(timeoutMs: number): Promise<LocationFix | null> {
    if (refreshInFlight) return refreshInFlight;
    const request = (async () => {
      try {
        const raw = await bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs });
        const fix = acceptFix(raw);
        if (!fix && !latestFix) locationUnavailable = true;
        return fix;
      } catch (error) {
        log.warn("getAppLocation failed", { error: String(error) });
        if (!latestFix) locationUnavailable = true;
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
    refreshInFlight = request;
    return request;
  }

  /** The promise's value, or `fallback` after `ms` of scheduler time. Never rejects. */
  function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let done = false;
      const finish = (value: T) => {
        if (done) return;
        done = true;
        scheduler.clearTimeout(timer);
        resolve(value);
      };
      const timer = scheduler.setTimeout(() => finish(fallback), Math.max(0, ms));
      promise.then(finish, () => finish(fallback));
    });
  }

  async function buildSnapshot(): Promise<EmergencySensorSnapshot> {
    const diagnostics: string[] = [];
    if (!started) diagnostics.push("Sensor collection was not running");

    // Location: use the cache; try for a fresher fix only within the budget.
    const cachedAge = latestFix ? locationAgeMs(latestFix, now()) : Infinity;
    if (cachedAge > FRESH_ENOUGH_MS) {
      await within(refreshLocation(SNAPSHOT_LOCATION_BUDGET_MS), SNAPSHOT_LOCATION_BUDGET_MS, null);
    }
    const capturedAtMs = now();
    const location = latestFix;
    if (!location) {
      diagnostics.push(
        locationUnavailable
          ? "Location unavailable or permission denied"
          : "No location fix available yet",
      );
    } else {
      if (locationAgeMs(location, capturedAtMs) > LOCATION_STALE_AFTER_MS) {
        diagnostics.push(`Location is last known, ${describeLocationAge(location, capturedAtMs)}`);
      }
      if (location.timestampSource === "received") {
        diagnostics.push(
          "Location time is when the phone received the fix, not the exact fix time",
        );
      }
    }

    // Motion.
    motion.prune(capturedAtMs);
    const motionSummary = summarizeMotion(motion.snapshot(), capturedAtMs);
    if (!imuArmed) diagnostics.push("IMU reporting could not be enabled");
    else if (motionSummary.sampleCount === 0) diagnostics.push("No IMU samples received yet");

    return validated({
      capturedAtMs,
      location,
      motionSummary,
      diagnostics: diagnostics.slice(0, 10),
    });
  }

  /** Never hand the SOS an invalid snapshot: drop whichever part fails validation. */
  function validated(snapshot: EmergencySensorSnapshot): EmergencySensorSnapshot {
    const parsed = EmergencySensorSnapshotSchema.safeParse(snapshot);
    if (parsed.success) return parsed.data;
    log.error("snapshot failed validation; dropping invalid parts");
    const shape = EmergencySensorSnapshotSchema.shape;
    const motionOk = shape.motionSummary.safeParse(snapshot.motionSummary).success;
    const locationOk = shape.location.safeParse(snapshot.location).success;
    const notes = snapshot.diagnostics.filter((d) => d.length >= 1 && d.length <= 200);
    if (!motionOk) notes.push("Motion summary was invalid and was omitted");
    if (!locationOk) notes.push("Location was invalid and was omitted");
    return {
      capturedAtMs: Math.max(0, Math.floor(snapshot.capturedAtMs)),
      location: locationOk ? snapshot.location : null,
      motionSummary: motionOk ? snapshot.motionSummary : null,
      diagnostics: notes.slice(0, 10),
    };
  }

  return {
    async startSensorCollection() {
      if (started) return;
      if (starting) return starting;
      starting = (async () => {
        // Listeners are registered once; repeated starts never duplicate them.
        unsubscribeHub ??= bridge.onEvenHubEvent(onHubEvent);
        unsubscribeLocation ??= bridge.onAppLocationChanged((raw) => {
          acceptFix(raw);
        });
        started = true;
        await arm();
        log.info("sensor collection started", { imuArmed, locationArmed });
      })().finally(() => {
        starting = null;
      });
      return starting;
    },

    async getEmergencySnapshot() {
      const fallback = (note: string): EmergencySensorSnapshot =>
        validated({
          capturedAtMs: now(),
          location: latestFix,
          motionSummary: null,
          diagnostics: [note],
        });
      try {
        const result = await within<EmergencySensorSnapshot | null>(
          buildSnapshot().catch(() => null),
          EMERGENCY_SNAPSHOT_TIMEOUT_MS,
          null,
        );
        return result ?? fallback("Sensor snapshot timed out or failed");
      } catch (error) {
        log.error("getEmergencySnapshot failed", { error: String(error) });
        return fallback("Sensor snapshot failed");
      }
    },

    async stopSensorCollection() {
      if (starting) await starting.catch(() => {});
      unsubscribeHub?.();
      unsubscribeLocation?.();
      unsubscribeHub = null;
      unsubscribeLocation = null;
      if (started) {
        await Promise.allSettled([
          bridge.imuControl(false, IMU_PACE),
          bridge.stopAppLocationUpdates(),
        ]);
      }
      started = false;
      imuArmed = false;
      locationArmed = false;
      motion.clear(); // no motion history is kept once Haven stops
      log.info("sensor collection stopped");
    },
  };
}
