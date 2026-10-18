import { describe, expect, it } from "vitest";
import {
  EmergencySensorSnapshotSchema,
  LOCATION_STALE_AFTER_MS,
  MotionSummarySchema,
  type MotionSample,
} from "@haven/contracts";
import { EMERGENCY_SNAPSHOT_TIMEOUT_MS } from "../core/interfaces";
import { silentLog } from "../core/log";
import { FakeBridge, ManualScheduler } from "../testing";
import { SNAPSHOT_LOCATION_BUDGET_MS, createDeviceService } from "./index";
import { createGoogleMapsLink, toLocationFix } from "./location";
import { MAX_BUFFERED_SAMPLES, MotionBuffer, summarizeMotion } from "./motion";

const T0 = 1_000_000;
const INTERPRETATION = /fell|fall|attack|assault|crash|collision|injur|unconscious/i;

function setup() {
  const bridge = new FakeBridge();
  const scheduler = new ManualScheduler(T0);
  const service = createDeviceService({ bridge, scheduler, log: silentLog });
  return { bridge, scheduler, service };
}

function imu(bridge: FakeBridge, x: unknown, y: unknown, z: unknown) {
  bridge.emitHostMessage({ type: "sysEvent", jsonData: { eventType: 8, imuData: { x, y, z } } });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function samples(
  count: number,
  stepMs: number,
  fn: (i: number) => [number, number, number],
): MotionSample[] {
  return Array.from({ length: count }, (_, i) => {
    const [x, y, z] = fn(i);
    return { timestampMs: T0 + i * stepMs, x, y, z };
  });
}

describe("createDeviceService: lifecycle", () => {
  it("registers listeners once and arms IMU and location, even when started repeatedly", async () => {
    const { bridge, service } = setup();
    await Promise.all([service.startSensorCollection(), service.startSensorCollection()]);
    await service.startSensorCollection();
    expect(bridge.listenerCount()).toBe(1);
    expect(bridge.imuCalls).toEqual([{ isOpen: true, pace: 100 }]);
    expect(bridge.locationUpdates).toBe(true);
  });

  it("stop unsubscribes, turns sensors off, and discards motion history", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    for (let i = 0; i < 5; i++) {
      imu(bridge, 0, 0, 1);
      scheduler.advance(100);
    }
    await service.stopSensorCollection();
    expect(bridge.listenerCount()).toBe(0);
    expect(bridge.imuCalls.at(-1)).toEqual({ isOpen: false, pace: 100 });
    expect(bridge.locationUpdates).toBe(false);
    const snapshot = await service.getEmergencySnapshot();
    expect(snapshot.motionSummary?.sampleCount).toBe(0);
    expect(snapshot.diagnostics).toContain("Sensor collection was not running");
  });

  it("re-arms sensors when the app returns to the foreground", async () => {
    const { bridge, service } = setup();
    await service.startSensorCollection();
    bridge.emitHostMessage({ type: "sysEvent", jsonData: { eventType: 4 } });
    await flush();
    expect(bridge.imuCalls.filter((c) => c.isOpen)).toHaveLength(2);
  });
});

describe("createDeviceService: motion", () => {
  it("buffers IMU samples and summarizes calm movement with no observations", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    for (let i = 0; i < 200; i++) {
      imu(bridge, 0.01 * (i % 3), 0.01 * (i % 2), 1);
      scheduler.advance(100);
    }
    const snapshot = await service.getEmergencySnapshot();
    const summary = snapshot.motionSummary!;
    expect(MotionSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.sampleCount).toBe(200);
    expect(summary.units).toBe("sdk_raw");
    expect(summary.observations.filter((o) => o.kind === "abrupt_change")).toHaveLength(0);
  });

  it("reports abrupt movement as a measurement, never as an incident", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    for (let i = 0; i < 150; i++) {
      if (i === 100) imu(bridge, 3, -2, 4);
      else imu(bridge, 0.01 * (i % 3), 0, 1);
      scheduler.advance(100);
    }
    const summary = (await service.getEmergencySnapshot()).motionSummary!;
    const abrupt = summary.observations.filter((o) => o.kind === "abrupt_change");
    expect(abrupt.length).toBeGreaterThan(0);
    for (const o of summary.observations) expect(o.detail).not.toMatch(INTERPRETATION);
  });

  it("discards invalid IMU values and notes it", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    imu(bridge, "abc", 0, 1);
    imu(bridge, 1e9, 0, 1);
    imu(bridge, null, null, null);
    scheduler.advance(100);
    const summary = (await service.getEmergencySnapshot()).motionSummary!;
    expect(summary.sampleCount).toBe(0);
    expect(summary.quality.notes.some((n) => n.includes("invalid"))).toBe(true);
  });

  it("reports missing IMU data explicitly", async () => {
    const { service } = setup();
    await service.startSensorCollection();
    const snapshot = await service.getEmergencySnapshot();
    expect(snapshot.motionSummary?.quality.level).toBe("none");
    expect(snapshot.diagnostics).toContain("No IMU samples received yet");
  });

  it("notes when IMU reporting cannot be enabled", async () => {
    const { bridge, service } = setup();
    bridge.imuControl = async () => false;
    await service.startSensorCollection();
    expect((await service.getEmergencySnapshot()).diagnostics).toContain(
      "IMU reporting could not be enabled",
    );
  });
});

describe("MotionBuffer and summarizeMotion", () => {
  it("keeps memory bounded", () => {
    const buffer = new MotionBuffer();
    for (let i = 0; i < MAX_BUFFERED_SAMPLES + 50; i++) buffer.add(T0 + i, 0, 0, 1);
    expect(buffer.size).toBe(MAX_BUFFERED_SAMPLES);
    expect(buffer.snapshot().truncated).toBe(true);
  });

  it("drops samples older than the rolling window", () => {
    const buffer = new MotionBuffer(1_000);
    buffer.add(T0, 0, 0, 1);
    buffer.add(T0 + 500, 0, 0, 1);
    buffer.add(T0 + 5_000, 0, 0, 1);
    expect(buffer.size).toBe(1);
  });

  it("reports sensor gaps and irregular sampling", () => {
    const before = samples(50, 100, () => [0, 0, 1]);
    const after = samples(50, 100, () => [0, 0, 1]).map((s) => ({
      ...s,
      timestampMs: s.timestampMs + 15_000,
    }));
    const summary = summarizeMotion({ samples: [...before, ...after] }, T0 + 25_000);
    expect(MotionSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.observations.some((o) => o.kind === "sensor_gap")).toBe(true);
    expect(summary.quality.longestGapMs).toBeGreaterThanOrEqual(10_000);
  });

  it("detects sustained high motion", () => {
    let seed = 7;
    const noise = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    const list = samples(600, 100, (i) =>
      i >= 100 && i < 200
        ? [0.6 * noise(), 0.6 * noise(), 1 + 0.6 * noise()]
        : [0.02 * noise(), 0.02 * noise(), 1],
    );
    const summary = summarizeMotion({ samples: list }, T0 + 60_000);
    expect(summary.observations.some((o) => o.kind === "sustained_high_motion")).toBe(true);
  });

  it("returns a valid empty summary with no samples", () => {
    const summary = summarizeMotion({ samples: [] }, T0);
    expect(MotionSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.statistics).toBeNull();
    expect(summary.quality.level).toBe("none");
  });
});

describe("createDeviceService: location", () => {
  it("uses a fresh cached fix from location updates", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    bridge.emitLocation({
      latitude: 34.0689,
      longitude: -118.4452,
      accuracy: 8,
      timestamp: scheduler.now() - 2_000,
    });
    const snapshot = await service.getEmergencySnapshot();
    expect(snapshot.location).toMatchObject({
      latitude: 34.0689,
      accuracyMeters: 8,
      timestampSource: "host",
    });
    expect(EmergencySensorSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("falls back to getAppLocation when there is no cached fix", async () => {
    const { bridge, scheduler, service } = setup();
    bridge.location = { latitude: 10, longitude: 20, accuracy: 5, timestamp: scheduler.now() };
    const snapshot = await service.getEmergencySnapshot();
    expect(snapshot.location).toMatchObject({ latitude: 10, longitude: 20 });
  });

  it("represents denied or unavailable location explicitly without blocking", async () => {
    const { service } = setup();
    await service.startSensorCollection();
    const snapshot = await service.getEmergencySnapshot();
    expect(snapshot.location).toBeNull();
    expect(snapshot.diagnostics).toContain("Location unavailable or permission denied");
  });

  it("labels stale fixes with their age", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    bridge.emitLocation({
      latitude: 1,
      longitude: 2,
      timestamp: scheduler.now() - LOCATION_STALE_AFTER_MS - 60_000,
    });
    const snapshot = await service.getEmergencySnapshot();
    expect(snapshot.location).not.toBeNull();
    expect(snapshot.diagnostics.some((d) => d.startsWith("Location is last known"))).toBe(true);
  });

  it("never waits past the budget for a slow GPS request", async () => {
    const { bridge, scheduler, service } = setup();
    bridge.getAppLocation = () => new Promise<never>(() => {}); // never resolves
    const pending = service.getEmergencySnapshot();
    scheduler.advance(SNAPSHOT_LOCATION_BUDGET_MS);
    const snapshot = await pending;
    expect(snapshot.location).toBeNull();
    expect(scheduler.now() - T0).toBeLessThanOrEqual(EMERGENCY_SNAPSHOT_TIMEOUT_MS);
    expect(EmergencySensorSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("serves concurrent snapshot requests consistently", async () => {
    const { bridge, scheduler, service } = setup();
    await service.startSensorCollection();
    bridge.emitLocation({ latitude: 5, longitude: 6, accuracy: 3, timestamp: scheduler.now() });
    const results = await Promise.all([1, 2, 3].map(() => service.getEmergencySnapshot()));
    for (const r of results) {
      expect(r.location).toMatchObject({ latitude: 5, longitude: 6 });
      expect(EmergencySensorSnapshotSchema.safeParse(r).success).toBe(true);
    }
  });
});

describe("toLocationFix and createGoogleMapsLink", () => {
  it("rejects out-of-range or non-numeric coordinates", () => {
    expect(toLocationFix({ latitude: 91, longitude: 0 }, T0)).toBeNull();
    expect(toLocationFix({ latitude: 0, longitude: 181 }, T0)).toBeNull();
    expect(toLocationFix({ latitude: Number.NaN, longitude: 0 }, T0)).toBeNull();
    expect(toLocationFix(null, T0)).toBeNull();
  });

  it("uses the receive time when the host omits or garbles the fix time", () => {
    expect(toLocationFix({ latitude: 1, longitude: 2 }, T0)).toMatchObject({
      timestampMs: T0,
      timestampSource: "received",
    });
    const future = toLocationFix({ latitude: 1, longitude: 2, timestamp: T0 + 10 * 60_000 }, T0);
    expect(future?.timestampSource).toBe("received");
  });

  it("converts second-based timestamps and drops invalid heading and accuracy", () => {
    const now = Date.UTC(2026, 9, 18, 9, 0, 0);
    const fix = toLocationFix(
      { latitude: 1, longitude: 2, timestamp: now / 1000 - 3, heading: -1, accuracy: -5 },
      now,
    );
    expect(fix).toMatchObject({
      timestampMs: now - 3_000,
      timestampSource: "host",
      accuracyMeters: null,
    });
    expect(fix?.headingDegrees).toBeUndefined();
  });

  it("builds a Google Maps link only for valid coordinates", () => {
    expect(createGoogleMapsLink({ latitude: 34.068921, longitude: -118.445181 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=34.068921%2C-118.445181",
    );
    expect(createGoogleMapsLink({ latitude: 95, longitude: 0 })).toBeNull();
    expect(createGoogleMapsLink(null)).toBeNull();
  });
});
