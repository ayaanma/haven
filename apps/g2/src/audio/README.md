# G2 emergency audio

`createAudioService({ bridge, http, scheduler, log })` implements the unchanged
`HavenAudioService` interface. It never reads touchpad input, creates an SOS, or
changes the HUD. Construction, idle use, countdown and cancellation do not open
the microphone. Agent 1 must call `startRecording(alertId)` **only after** the
`alert.initial_notification_accepted` event, following onboarding acknowledgment
of automatic emergency recording and the platform microphone permission.

The startup page must already exist. The factory explicitly requests
`AudioInputSource.Glasses`, accepts only that source on `event.audioEvent`, and
immediately copies the PCM. There is no phone-microphone fallback, speech
recognition, AI audio analysis, or background recording promise.

## States and integration

Internal states are `IDLE → STARTING → RECORDING → STOPPING → UPLOADING →
FINALIZING → COMPLETE`, with `FAILED` for interrupted capture or submission.
Only listed transitions are allowed. A failed submission can resume with
`stopAndSendRecording(theSameAlertId)` using its original recording ID, chunk
indexes and completion parameters. Starting the same alert twice shares the
original start promise. Concurrent stops share one submission; successful repeats
return the saved result. An unrelated alert cannot stop or submit the active one.

The existing typed `onProgress` contract is the HUD integration surface:

| Phase                     | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `idle`, recording ID null | No recording requested                                           |
| `idle`, recording ID set  | Recording requested; microphone command pending                  |
| `recording`               | Microphone opened; `elapsedMs` updates every second              |
| `stopping`                | Stop requested; waiting for microphone-close confirmation        |
| `uploading`               | Microphone closed; remaining chunks uploading                    |
| `notifying`               | All chunks acknowledged; backend completion/notification pending |
| `sent`                    | Backend reports at least one Photon acceptance; **not delivery** |
| `failed`                  | Capture, upload, finalization, or notification was not confirmed |

`uploadedChunks` and `pendingChunks` are acknowledged and remaining chunk counts.
The backend `recording.upload_completed` event separately confirms finalization;
`recording.notification_accepted` confirms provider acceptance. Delivery remains
Agent 2's per-contact `notification.delivered` event. The fixed foundation
progress interface has no separate requested/finalized/pending fields; these
phases and backend events preserve that contract without changing foundation
types. The final return value is authoritative: never display “Recording sent”
for local buffering, an HTTP alert acceptance, or a zero-acceptance result.

## Capture and upload

- Input: 16 kHz signed 16-bit little-endian mono PCM (32,000 bytes/second).
- Chunks: at most 64 KiB, with a partial flush every second and at stop. Indexes
  start at zero. Event boundaries may split a sample; concatenation preserves
  bytes. An incomplete final sample is rejected rather than silently trimmed.
- Each chunk uses its recording UUID, index and SHA-256 with the shared
  authenticated HTTP transport and response schemas. Retryable errors get three
  attempts with 250 ms and 500 ms backoff. Failed chunks retain their identities.
- The unacknowledged audio budget is 2 MiB. Capture stops with a failure event
  before accepting data beyond that limit. It also stops at ten minutes, after
  five seconds without a frame, on lifecycle exit, or on device disconnection.
  The device-status callback does not distinguish a ring from glasses, so an
  unidentified disconnection conservatively interrupts capture too.
- Stop is atomic before awaiting the bridge. Capture remains subscribed until
  close acknowledgment so final frames can arrive. A failed or timed-out close
  returns a recoverable failure instead of claiming the microphone stopped.
  A late successful open after timeout/disposal triggers another close.
- The HUD timer uses the scheduler clock. Playback duration is computed from the
  received PCM samples; dropped frames are not replaced with invented silence.

IndexedDB checkpoints persist pending chunks, the partial tail, and upload
metadata. Writes are serialized and coalesced to bound memory. Acknowledged bytes
are released. A new service can submit a matching checkpoint without opening the
microphone. It refuses to overwrite pending evidence with a new recording.
Completed checkpoints are deleted; pending checkpoints older than seven days
are deleted on restoration. This is best effort: platform eviction, unavailable
IndexedDB, quota failures, abrupt power loss, and the last uncheckpointed second
can lose local data. Storage failures log a generic message and retain evidence
in bounded memory. Previously acknowledged chunks remain on the server.

`disposeRecording()` is terminal for that service instance: it closes capture,
detaches listeners, cancels requests/backoff, and checkpoints remaining evidence
without requesting finalization or messaging. Construct a new service to recover
after shutdown. No microphone is reopened automatically on foreground.

## Verification and manual device test

Automated tests use the real SDK parser, `FakeBridge`, `ManualScheduler`, the
real validated HTTP client with a fake server, and an asynchronous IndexedDB
double. They exercise idle input, startup/stop races, timeout/permission errors,
wrong sources, buffer reuse, chunking, retries, recovery, duration, disconnection,
disposal, duplicate stops, and absence of SOS requests from this module.

The complete device test requires Agent 1's workflow and Agent 2's alert,
consent, and notification implementations. Their foundation placeholders do not
provide an end-to-end demo on this branch alone.

1. On iOS and Android, sideload Haven with `g2-microphone` permission, complete
   automatic-recording acknowledgment, pair, and configure a consenting contact.
   Begin in mock mode; live testing requires that contact's explicit participation.
2. With Haven active, verify a blank HUD and no mic activity. Single press, then
   cancel during the five-second countdown. Verify no audio upload or message.
3. Single press again and let the countdown expire. Verify the initial SOS and
   location message are accepted before audio starts. A failed/all-rejected SOS
   must never start capture.
4. Verify “Recording...” and “Click to send audio”, with a running timer. Speak
   known words. Confirm chunks reach the backend before stopping.
5. Single press once. Verify mic closure, final chunk flushing, completion, and a
   recording-link notification to the original eligible emergency contacts. This
   press must not create another SOS. Rapid duplicate stops must not resend.
6. Open the link on ordinary iOS Safari and Android Chrome. Verify audible known
   words, correct duration, seeking, and byte-range playback without another app.
   Treat provider acceptance separately from confirmed delivery/contact replies.
7. Repeat with network loss, denied microphone permission, glasses disconnection,
   phone lock/background/relaunch, and an expired link. Verify failures are honest,
   checkpoints can resume, and capture does not silently restart. A powered-off
   phone cannot record or upload.

Physical microphone behavior, permission UX, iOS/Android playback and actual
Photon delivery require hardware/account testing; fake-bridge tests cannot verify
those properties.

Sources checked 2026-10-18: [Even Hub device/audio APIs](https://hub.evenrealities.com/docs/build/device-apis),
[background lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle),
installed SDK `0.0.16` declarations and simulator `0.9.5` README.
