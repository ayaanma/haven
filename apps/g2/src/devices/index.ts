// Owner: Agent 3. Placeholder created by the foundation commit.
//
// Implement with the bridge (Even Hub SDK 0.0.16):
//   - Location: startAppLocationUpdates + onAppLocationChanged to cache the latest phone fix;
//     getAppLocation({ accuracy: High, timeoutMs }) as a bounded fallback. Map AppLocation to
//     LocationFix (accuracy → accuracyMeters | null, timestamp → timestampSource "host"|"received").
//   - Motion: imuControl(true, ImuReportPace.P...) and sysEvent.imuData where
//     eventType === IMU_DATA_REPORT (8). Keep a ring buffer of MotionSample for
//     MOTION_SUMMARY_WINDOW_MS and summarize to MotionSummary (raw SDK units).
//   - Android may suspend the WebView: re-arm location/IMU on foreground_enter.
// getEmergencySnapshot must never reject and must resolve within EMERGENCY_SNAPSHOT_TIMEOUT_MS.
import type { DeviceServiceDeps, HavenDeviceService } from "../core/interfaces";

export function createDeviceService(deps: DeviceServiceDeps): HavenDeviceService {
  return {
    async startSensorCollection() {
      deps.log.warn("sensor collection not implemented yet (Agent 3)");
    },
    async getEmergencySnapshot() {
      return {
        capturedAtMs: deps.scheduler.now(),
        location: null,
        motionSummary: null,
        diagnostics: ["Device service not implemented yet"],
      };
    },
    async stopSensorCollection() {},
  };
}
