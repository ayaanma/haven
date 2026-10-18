# Emergency audio storage and playback

The factory `createRecordingStorage(ctx)` preserves the foundation storage
interface. Authenticated routes require `audio:write` and match the alert's
`session_id` to the caller. Unknown or other-session alerts return 404. Alerts
created without an owning session are not writable through these routes. Chunk
storage additionally requires initial SOS acceptance (`notified` or the accepted
event). The frontend cannot supply recipients or a playback storage path.

## Data and limits

Chunks are raw G2 PCM: 16 kHz, signed 16-bit little-endian, one channel.
Uploads require `application/octet-stream`, a UUID recording ID, index 0–999,
1–256 KiB bodies, and a matching SHA-256. Out-of-order uploads work. Repeating the
same index/hash/length returns `duplicate`; different bytes conflict. The same
recording ID cannot cross alerts. One recording is allowed per SOS, preventing a
client from bypassing size limits by cycling recording IDs.

The ten-minute limit is **19,200,000 PCM bytes**, enforced independently of chunk
count or supplied duration. Completion requires exactly indexes 0…chunkCount−1,
whole 16-bit samples, and duration matching the captured sample count (rounded to
milliseconds, minimum one millisecond). It rejects extra or missing chunks.

Files are atomically written and fsynced, mode 0600, under the configured private
`AUDIO_STORAGE_PATH` (new directories mode 0700). Random filenames are independent
of client IDs. Reads reject paths outside that root and use `O_NOFOLLOW` to reject
symlinks. Chunks and finalized WAV files are SHA-256 checked. SQLite holds metadata
and file references; tokens and raw audio never enter audio-module logs. There
are no publicly served asset files or storage credentials in notifications.

Finalization assembles a standard 44-byte RIFF/WAVE PCM header and exact sample
bytes. It persists `receiving → finalizing → completed` and emits
`recording.started` / `recording.upload_completed`. Repeating completion with the
same immutable parameters returns the same metadata. A disk/read/integrity
failure does not notify contacts or claim completion; available chunks remain
retryable.

## Secure playback and retention

Each link has a cryptographically random 256-bit token, with only its SHA-256
stored in `share_links`. It expires within seven days of finalization and can be
revoked using the existing `revoked_at` field. Unknown, malformed, expired,
revoked, missing or corrupted audio returns 404. Live mode requires HTTPS.

**Anyone possessing a valid link can access the audio until it expires or is
revoked.** It is a capability credential, with no contact login required. Do not
put it in analytics, access logs, screenshots, or public links. Configure proxy
access logs to redact `/r/` paths; `Referrer-Policy: no-referrer` prevents playback
URLs becoming referrers. The expected outbound message necessarily contains the
link; Agent 2 owns that messaging/retention surface.

`GET /r/:token` serves `audio/wav`, `inline`, `private, no-store`, `noindex,
nofollow`, and byte ranges (206/416). HEAD is supported. Raw WAV playback is
intended for normal mobile browsers; hardware/browser validation is still needed.

`cleanupExpiredRecordings(ctx)` deletes expired chunks, WAVs, share links and
notification receipts. It retains a failed metadata tombstone to prevent ID reuse.
It also deletes expired orphan UUID files from interrupted writes, leaving
unrelated files untouched. Routes sweep at most once per minute on audio traffic;
an idle deployment must schedule this exported function for prompt deletion.
Seven-day retention begins at completion, or creation for unfinished recordings.
This implementation uses bounded synchronous file I/O for the hackathon; the
replaceable storage interface supports a later streaming/object-storage adapter.

## Notification and crash behavior

Completion invokes **only** `container.notifications.sendRecordingNotification`
with the original alert ID and capability URL. Agent 2 must choose that alert's
original eligible recipients and use its stable provider idempotency keys. No
separate Photon client is instantiated here. Required message copy for Agent 2:

```text
HAVEN AUDIO RECORDING
An audio recording was captured following the emergency alert.
Listen here:
[Secure link]
Please contact 911 if you believe the wearer requires emergency assistance.
```

Concurrent completion requests share one task. A private, exclusive, fsynced
notification claim prevents another process or retry from initiating a second
send. A completion receipt persists only response metadata/counts, never the URL.
Successful retries and API reconstruction replay the receipt. Provider acceptance
emits `recording.notification_accepted`; zero acceptance with terminal failures
emits `recording.failed`. Acceptance is not proof of delivery.

Queued or ambiguous notifications return 503 while audio remains saved. Repeating
completion reconciles Agent 2's persisted `recording_link` statuses; accepted or
all-failed rows resolve without sending again. If a process fails after claiming
but before a definitive provider outcome/row exists, the receipt remains pending.
It intentionally cannot safely auto-resend. An operator must reconcile with
Agent 2/provider records; do not delete pending claims blindly. The known
foundation `NotImplementedError` has no send side effect and releases its claim
so integration can proceed after Agent 2 lands.

The foundation notification interface is alert-scoped, not recording-scoped; the
one-recording-per-alert policy matches its idempotency semantics. Its current
adapter is still a placeholder on this branch, so a real SOS/contact delivery
demonstration depends on Agent 2.

## Photon media investigation

Verified 2026-10-18 against [Photon's Beta API reference](https://photon.codes/docs/beta/api-reference),
the [public OpenAPI schema](https://api.photon.codes/openapi.json), and installed
`@photon-ai/api` 0.5.0 generated typings:

- The schema documents `POST /v1/projects/{id}/attachments`, with a
  `multipart/related` body, returning an attachment.
- `AttachmentContent` refers to `attachmentId`. Both iMessage and SMS content
  schemas include attachment content. iMessage's content union omits native
  `VoiceContent`; SMS's schema includes it. These schemas do not establish WAV
  delivery/voice-note behavior for Haven's particular account and provisioned line.
- The [Beta messaging guide](https://photon.codes/docs/beta/messaging) currently
  says that section is being rewritten. Account/channel media capability and
  real delivery are unverified; no live provider request was made.

Therefore Strategy B, the secure WAV URL, is implemented. Strategy A must be
enabled in Agent 2's adapter only after confirming documented format/channel/account
support, and would need an agreed media-capable interface. This module does not
guess media fields, borrow the legacy Spectrum API, or add dependencies.

## Checks and integration handoff

Audio tests use the real Hono app/auth/SQLite schema and private temporary
directories, plus fake notifications. No real recipients are contacted. They
cover WAV headers, out-of-order/duplicate uploads, ownership/scopes, body/hash/size
limits, missing/corrupt chunks, filesystem failures, secure-link expiry/revocation,
range/HEAD playback, cleanup, restart/concurrency deduplication and pending-status
reconciliation. The G2 module's README contains the complete manual device test.

Foundation proposal [#2](https://github.com/ayaanma/haven/issues/2) requests the
single stale `apps/api/src/app.test.ts` expectation change from playback placeholder
501 to the documented unknown-token 404. That foundation-owned test is unchanged
on this branch; it currently prevents the full suite/`npm run verify` from passing.
