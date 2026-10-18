# Hardware test plan

The simulator is "not an emulator" (Even Hub docs): it does not reproduce firmware input
timing, BLE latency, permissions, or background lifecycle. Everything below must be checked on
real Even G2 glasses with the Even Realities app on **both an iPhone and an Android phone**.
Record results in the table at the end and update the constants or docs they affect.

## Setup

1. Even Realities app ≥ **2.2.10** (required by SDK 0.0.16). Enable Developer Mode so the Even
   Hub tab shows **Scan QR** (Even Hub docs: Get Started → Hardware).
2. Laptop and phone on the same network, without client isolation (a phone hotspot works).
3. `apps/g2/.env.local`: `VITE_HAVEN_API_BASE_URL=http://<laptop-LAN-IP>:8787`.
4. `.env`: mock modes, `ALLOWED_ORIGINS=*`.
5. Run `npm run dev:api`, `npm run dev:g2`, then `npm run qr -w @haven/g2` and scan the QR code.
6. Open the WebView console from the app's Developer Mode screen. Useful lines:
   - `[EvenAppBridge] EvenHub event: {...}`: the SDK's own log of every raw host event;
   - `[haven:input] input single_press|double_press|lifecycle {...}`: Haven's normalized input;
   - `[haven:main] ready`.

QR sideload dies when the phone locks (Even Hub docs). Use a private build (`npm run pack:g2`,
upload through the developer portal) for H10 and H11.

## Tests

### H1: Blank idle HUD

Launch Haven. **Expect:** nothing visible on the glasses; console shows `[haven:main] ready`.

### H2: Single-press event shape

Single-press the right temple 10 times, slowly (> 1 s apart). For each, copy the raw
`EvenHub event` line. Repeat with the left temple and the R1 ring.

**Expect:** exactly one `single_press` per press. **Record:** envelope (`sysEvent` or
`textEvent`), whether `eventType` is omitted or `0`, and `eventSource` (1 = right, 3 = left,
2 = ring). Simulator 0.9.5 sends `sysEvent {eventSource: 1}` with no `eventType`.

### H3: Double-press sequence and timing (tunes `DEFAULT_CLICK_DISAMBIGUATION_MS`)

Double-press 20 times at a natural speed. **Record:**

- whether a CLICK event arrives **before** the DOUBLE_CLICK (`eventType: 3`) event;
- the gap between them (SDK log timestamps; add `Date.now()` logging if needed);
- whether any `single_press` was emitted (it must not be).

**Then:**

- If firmware never sends a CLICK first, the window can shrink (e.g. 150 ms) to cut latency.
- If it sends CLICK first with gap G, set the window to at least `max(G) + 100 ms`.
- Update `DEFAULT_CLICK_DISAMBIGUATION_MS` in `apps/g2/src/core/input/disambiguator.ts`
  (foundation) and note the firmware and app versions here.

Also double-press while **holding** the phone app in the background (where possible) and
right after a single press (single press → 300 ms → double press). The double press must
open the exit dialog and must not cancel or start an SOS.

### H4: Exit dialog

Double-press from the idle HUD. **Expect:** the system exit-confirmation dialog appears.
Confirm exit: the glasses return to the launcher, the phone-side WebView closes, and
first-party apps (e.g. Conversate) launch without a restart (Even Hub QA rules).

### H5: Countdown and cancel

1. Press → countdown appears within ~0.5 s and counts 5→1.
2. Press again at ~2 s → cancelled, HUD blank, no `POST /alerts` in the API log.
3. Press, then cancel as late as possible (aim for 4.8–4.95 s) 10 times. **Expect:** every press
   before the deadline cancels (`isCancelPressInTime` uses raw press time), and no alert is created.
4. Let it expire → exactly one `POST /api/v1/alerts`; retries reuse the same `clientAlertId`.

### H6: Recording-state press

After an SOS (mock mode), wait for "Recording...". Press once. **Expect:** recording stops and
uploads; no second alert is created. Press again in ACTIVE_ALERT: nothing happens.

### H7: Long press and contextual menu do nothing

Long-press, and tap-then-hold (which raises the OS contextual menu). **Expect:** no countdown, no
cancel. Haven ignores long-press events (`LONG_PRESS_EVENT` 9 / `LONG_PRESS_RELEASE_EVENT` 10).

### H8: IMU characterization (Agent 3)

With `imuControl(true, ImuReportPace.P100…P1000)`, record 60 s each of: still head, normal walking,
nodding, sharp turns, and a simulated stumble (safely). **Record:** actual sample rate per pace code,
value ranges per axis at rest (is gravity ≈ 1 or ≈ 9.8 on one axis? or are these angles?), and
axis orientation. Update the `MotionSummary` docs and the AI prompt with the findings.

### H9: Location (Agent 3)

Outdoors and indoors on both phones: `getAppLocation({accuracy: High, timeoutMs: 5000})` and
continuous updates. **Record:** time to first fix, `accuracy` values, whether `timestamp` is
present (→ `timestampSource`), and behavior with location permission denied (must return null,
and the SOS must still send).

### H10: Background, lock, and resume

Private or beta build. With Haven active: lock the phone 5 minutes, then press. On Android,
also open several heavy apps to force memory pressure. **Record:** whether presses still arrive
while locked, whether the WebView was cold-started (state lost), and whether IMU, location, and mic
resume. An in-flight alert must resume polling from the stored cursor, not start a second SOS.

### H11: Packaged build networking

`VITE_HAVEN_API_BASE_URL=https://<your API> npm run pack:g2`, then install the private build.
**Record:** the WebView `Origin` header seen by the API (needed for a tight `ALLOWED_ORIGINS`),
and confirm that requests to a non-whitelisted origin are blocked.

### H12: Live Photon end to end (consenting testers only)

`PHOTON_MODE=live` with a dedicated Photon project and **only volunteers who agreed to receive
test emergency messages**. Each tester texts Haven's line first. **Expect:** messages contain
the help request, "call 911", a Maps link, timestamp, and accuracy; status moves
`photon_accepted` → `delivered` or `delivery_unconfirmed`; replies show on the HUD with the
right name; the recording link plays on iOS and Android. Capture one real webhook request
(headers + body) to confirm the signature scheme. Tell testers beforehand, and never use
anyone who might call real emergency services.

### H13: Microphone (Agent 4)

Record 30 s in quiet and noisy rooms. **Confirm:** PCM 16 kHz s16le mono, the bytes per
`audioEvent`, and no gaps between events; the WAV plays back correctly; capture stops when
the WebView is suspended, and the HUD says so.

## Results

| Test | Date | iOS / Android | Firmware / app | Result | Notes / constants changed |
| ---- | ---- | ------------- | -------------- | ------ | ------------------------- |
| H1   |      |               |                |        |                           |
| H2   |      |               |                |        |                           |
| H3   |      |               |                |        |                           |
| H4   |      |               |                |        |                           |
| H5   |      |               |                |        |                           |
| H6   |      |               |                |        |                           |
| H7   |      |               |                |        |                           |
| H8   |      |               |                |        |                           |
| H9   |      |               |                |        |                           |
| H10  |      |               |                |        |                           |
| H11  |      |               |                |        |                           |
| H12  |      |               |                |        |                           |
| H13  |      |               |                |        |                           |

## Already verified without hardware (2026-10-18)

| Check                                                     | How                                   | Result |
| --------------------------------------------------------- | ------------------------------------- | ------ |
| SDK passes an omitted `eventType` through as `undefined`  | `sdk-contract.test.ts` (SDK 0.0.16)   | Pass   |
| Simulator click shape: `sysEvent {eventSource:1}`         | `npm run sim:smoke` (simulator 0.9.5) | Pass   |
| Simulator double click: `eventType 3`, no preceding click | `npm run sim:smoke`                   | Pass   |
| One click → exactly one `single_press`                    | `npm run sim:smoke`                   | Pass   |
| Double click → `ShutDownPageContainer`, no single press   | `npm run sim:smoke` + unit tests      | Pass   |
| Idle HUD draws 0 pixels (positive control: text → 473)    | `npm run sim:smoke` screenshot        | Pass   |
| Manifest accepted; `min_app_version` stamped 2.2.10       | `npm run pack:g2` (CLI 0.1.14)        | Pass   |
