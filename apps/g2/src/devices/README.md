# Agent 3: sensors and AI context

Files: `apps/g2/src/devices/**` (G2 side) and `apps/api/src/context/**` (backend).

## G2: `createDeviceService({ bridge, scheduler, log })`

- **Location** (`location.ts`): `startAppLocationUpdates` + `onAppLocationChanged` keep the
  newest valid phone fix. `getAppLocation` is a bounded fallback when the cached fix is older
  than 15 s. Fixes are validated (lat/lon ranges), the timestamp source is recorded (`host` or
  `received`), invalid heading/accuracy values are dropped, and stale fixes are labeled with
  their age in `diagnostics`.
- **Motion** (`motion.ts`): `imuControl(true, ImuReportPace.P100)` and `sysEvent.imuData` feed
  a `MotionBuffer` capped at 60 s and 6,000 samples. `summarizeMotion` is pure and
  deterministic. Thresholds are relative to the window's own data because IMU units and axes
  are undocumented. Observations describe measurements only, never incidents.
- **Snapshot**: `getEmergencySnapshot()` never rejects, resolves within
  `EMERGENCY_SNAPSHOT_TIMEOUT_MS` (1.5 s), and is validated against
  `EmergencySensorSnapshotSchema` (invalid parts are dropped with a diagnostic).
- **Lifecycle**: repeated `startSensorCollection()` calls never duplicate listeners. Sensors are
  re-armed on `FOREGROUND_ENTER_EVENT` (Android WebView suspension). `stopSensorCollection()`
  turns sensors off and discards motion history.

## Backend: `createContextService(ctx)`

- `LLM_MODE=mock`: no network, always `insufficient_information`.
- `LLM_MODE=live`: Gemini 2.5 Flash-Lite via `${LLM_BASE_URL}/chat/completions`, JSON mode,
  temperature 0, 10 s timeout. Never rejects.
- The model never receives coordinates (it has no map data and could only guess place names).
  `locationDescription` is built deterministically from fix accuracy and age.
- A deterministic evidence assessment caps `evidenceQuality` and sets an uncertainty floor
  (never `low`). With no usable evidence the model is not called.
- Model output is Zod-validated; sentences asserting incidents (attack, crash, fall, injury,
  and similar) are dropped.
- Reverse geocoding is not implemented (optional in the spec); the SOS never depends on it.

## Verification status

| Behavior                                         | Verified by                              |
| ------------------------------------------------ | ---------------------------------------- |
| IMU, click, and foreground parsing               | Real SDK 0.0.16 parser                   |
| Motion summary on calm, spike, gap, invalid data | Unit tests (synthetic data)              |
| Snapshot timeout, concurrency, cleanup           | Unit tests (FakeBridge, ManualScheduler) |
| Context validation, grounding, timeout, errors   | Unit tests (stubbed fetch)               |
| IMU units, axes, real sample rate per pace       | **Not verified on hardware**             |
| Location on real iOS/Android phones              | **Not verified on hardware**             |
| Live Gemini call with a real key                 | **Not verified**                         |

## Hardware calibration checklist (see docs/HARDWARE_TEST_PLAN.md H8, H9)

1. Log `effectiveSampleRateHz` from a snapshot for `ImuReportPace.P100`, `P500`, and `P1000`.
   Pick the pace that gives roughly 10 to 50 Hz and update `IMU_PACE`.
2. Hold the head still for 30 s: confirm no `abrupt_change` and quality `good`.
3. Walk normally for 30 s: confirm no `abrupt_change` (tune `ABRUPT_FACTOR` if it fires).
4. Make one sharp head turn: confirm one `abrupt_change` near that time.
5. Record whether the still-head magnitude is near 1 (g) or near 9.8 (m/s²) to identify units.
6. Location outdoors and indoors on both phones: note accuracy, fix age, whether `timestamp`
   is present, and behavior with location permission denied (must give `location: null`).
7. Background the Even app and return: confirm samples resume after `FOREGROUND_ENTER_EVENT`.
