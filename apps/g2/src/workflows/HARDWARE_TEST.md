# Agent 1 real-G2 test checklist

Run these checks on both iOS and Android with Even App 2.2.10 or newer, a connected G2, and
the packaged Haven plugin. Use `PHOTON_MODE=mock` until the live-messaging checks are explicitly
authorized with consenting test contacts.

## iOS

1. Open Haven from the glasses menu. Confirm the HUD is visually blank while a press is still
   captured.
2. Single-press once. Confirm the danger prompt appears with `5`, then counts down `4 3 2 1`.
3. Repeat and single-press just before five seconds. Confirm the HUD clears and the mock outbox,
   alert table, and microphone remain untouched.
4. Let the countdown finish. Confirm exactly one alert is created and the HUD says it is contacting
   emergency contacts; it must not say sent or start audio from the HTTP response alone.
5. Emit `alert.initial_notification_accepted`. Confirm recording starts once and the HUD says
   `SOS sent`, never "delivered" before a delivery event.
6. Single-press during recording. Confirm this stops and sends that recording, creates no second
   alert, and extra presses during upload do nothing.
7. Simulate a signed contact reply. Confirm the exact contact name and reply appear once.
8. Double-press from IDLE, COUNTDOWN, and RECORDING. Confirm the system exit dialog remains
   available and no single-press action fires. Decline the dialog and confirm text HUD updates still
   work.
9. Background and foreground the Even App during an active alert. Confirm polling resumes from the
   stored cursor and does not duplicate replies or restart the SOS.

## Android

Repeat iOS steps 1–9, then:

1. During `WAITING_FOR_PHOTON`, background the Even App long enough for Android to destroy the
   WebView. Reopen Haven and confirm it resumes the stored alert rather than creating another one.
2. Repeat during `RECORDING`. Confirm the backend alert status is recovered and microphone capture
   is re-armed at most once.
3. Repeat during `UPLOADING_AUDIO`. Confirm Haven reports the interrupted recording honestly and
   keeps the alert active; it must not claim the recording was sent.
4. Disable network access for two poll cycles, restore it, and confirm cursor polling recovers with
   backoff and shows each reply once.

Record the phone model, OS version, Even App version, G2 firmware, input source (right temple, left
temple, or R1), observed single/double-press envelopes, and whether the provisional 400 ms
disambiguation window prevented false singles without feeling unacceptably slow.
