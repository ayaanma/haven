# Haven API contracts

The Zod schemas in [`packages/contracts/src`](../packages/contracts/src) are authoritative.
This document explains them. Both apps validate against the same schemas: the backend
validates requests, the G2 HTTP client validates responses, and the event log validates
every event it appends.

Conventions:

- JSON over HTTPS. All timestamps are **Unix epoch milliseconds** (UTC).
- IDs: alerts `alt_<24 base32>`, contacts `ctc_<24 base32>`, sessions `ses_...`.
  `clientAlertId` and `recordingId` are client-generated UUIDs.
- Auth: `Authorization: Bearer hvn_<43 base64url>` unless marked public.
- Request bodies are strict: unknown fields are rejected with 400.
- Every response carries `X-Request-Id`.

## Errors

Every non-2xx JSON response has this shape (`ApiErrorBodySchema`):

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request body failed validation",
    "requestId": "9985cdba-0718-4bea-bc40-e57c7606de9a",
    "issues": [{ "path": "clientAlertId", "message": "Invalid UUID" }]
  }
}
```

| Status | `code`              | When                                                                                   | Retry?                                        |
| ------ | ------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| 400    | `invalid_request`   | Malformed JSON, schema violation, bad path/query parameter                             | No                                            |
| 401    | `unauthorized`      | Missing, unknown, expired, or revoked token; wrong pairing code; bad webhook signature | No (re-pair)                                  |
| 403    | `forbidden`         | Token lacks the scope                                                                  | No                                            |
| 404    | `not_found`         | Unknown route, alert, or recording link                                                | No                                            |
| 409    | `conflict`          | Audio chunk index re-sent with different bytes                                         | No                                            |
| 413    | `payload_too_large` | JSON > 64 KB, chunk > 256 KB, webhook > 1 MB                                           | No                                            |
| 429    | `rate_limited`      | Too many pairing attempts                                                              | Later                                         |
| 501    | `not_implemented`   | Feature placeholder not yet built                                                      | No                                            |
| 503    | `unavailable`       | Dependency temporarily unavailable                                                     | Yes, same request                             |
| 500    | `internal_error`    | Bug                                                                                    | Yes, same request (idempotent endpoints only) |

## Endpoints

| Method | Path                                     | Auth / scope     | Owner                                                |
| ------ | ---------------------------------------- | ---------------- | ---------------------------------------------------- |
| GET    | `/healthz`                               | public           | foundation                                           |
| POST   | `/api/v1/auth/session`                   | public (pairing) | foundation                                           |
| GET    | `/api/v1/contacts`                       | `contacts:read`  | Agent 2                                              |
| PUT    | `/api/v1/contacts`                       | `contacts:write` | Agent 2                                              |
| POST   | `/api/v1/alerts`                         | `alerts:write`   | Agent 2                                              |
| GET    | `/api/v1/alerts/:alertId`                | `alerts:read`    | Agent 2                                              |
| GET    | `/api/v1/alerts/:alertId/events`         | `alerts:read`    | Agent 2 (default implementation from the foundation) |
| POST   | `/api/v1/alerts/:alertId/audio/chunks`   | `audio:write`    | Agent 4                                              |
| POST   | `/api/v1/alerts/:alertId/audio/complete` | `audio:write`    | Agent 4                                              |
| POST   | `/api/v1/photon/webhooks`                | Photon signature | Agent 2                                              |
| GET    | `/r/:token`                              | capability token | Agent 4                                              |

### `GET /healthz`

`200` `HealthResponseSchema`: `{ "status": "ok", "photonMode": "mock" | "live", "llmMode": "mock" | "live" }`

### `POST /api/v1/auth/session`

Exchange the server-configured pairing code for a wearer session. Rate-limited to 10 attempts
per 5 minutes per client address.

Request (`CreateSessionRequestSchema`):

| Field         | Type                | Notes                           |
| ------------- | ------------------- | ------------------------------- |
| `pairingCode` | string (1–128)      | Must equal `HAVEN_PAIRING_CODE` |
| `deviceLabel` | string (1–64), opt. | For logs                        |

`201` (`CreateSessionResponseSchema`):

```json
{
  "sessionToken": "hvn_eRzMnggfeli-qr98Vux9DM6NLJFhKr_9P5AjnPuoplQ",
  "tokenType": "Bearer",
  "expiresAt": 1794906346415,
  "scopes": ["contacts:read", "contacts:write", "alerts:read", "alerts:write", "audio:write"]
}
```

Errors: `400`, `401` (wrong code), `429`. The token is shown once; the server stores only its SHA-256.

### `GET /api/v1/contacts`

`200` `ContactsResponseSchema`: `{ "contacts": EmergencyContact[] }` (at most 5, in display order).

`EmergencyContact`:

| Field                    | Type                                 | Notes                                                                   |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------------- |
| `id`                     | `ctc_...`                            |                                                                         |
| `displayName`            | string (1–40, no control characters) | Shown on the HUD for replies                                            |
| `phoneNumber`            | E.164 (`+14155550123`)               |                                                                         |
| `enabled`                | boolean                              | Wearer's switch                                                         |
| `consent.status`         | `pending` \| `verified` \| `revoked` | Server-controlled. Only `enabled && verified` contacts receive alerts   |
| `consent.updatedAt`      | ms \| null                           |                                                                         |
| `optInNumber`            | E.164 \| null                        | Haven number this contact texts to opt in (per contact on shared lines) |
| `createdAt`, `updatedAt` | ms                                   |                                                                         |

### `PUT /api/v1/contacts`

Replace the whole list (`SaveContactsRequestSchema`):

```json
{
  "contacts": [
    {
      "id": "ctc_000000000000000000000001",
      "displayName": "Mom",
      "phoneNumber": "+14155550123",
      "enabled": true
    },
    { "displayName": "Dad", "phoneNumber": "+14155550124", "enabled": true }
  ]
}
```

- At most 5 entries; phone numbers and IDs must be unique.
- With `id`: update that contact. Its consent is kept only if the phone number is unchanged;
  otherwise it resets to `pending`.
- Without `id`: add a contact (`pending`).
- Contacts omitted from the list are deleted. Past alerts keep their contact snapshots.
- Clients cannot set `consent`; including it is a 400.

`200` `ContactsResponseSchema` with the saved list. An unknown `id` is a 400.

### `POST /api/v1/alerts`

Create an SOS. Sent when the countdown expires.

Request (`SOSRequestSchema`):

| Field           | Type                      | Notes                                                     |
| --------------- | ------------------------- | --------------------------------------------------------- |
| `clientAlertId` | UUID                      | **Idempotency key.** Reuse it for every retry of this SOS |
| `activatedAt`   | ms                        | When the activation press happened                        |
| `location`      | `LocationFix`, optional   | Latest phone fix                                          |
| `motionSummary` | `MotionSummary`, optional | Recent head motion (see below)                            |

`LocationFix`: `latitude` (−90..90), `longitude` (−180..180), `accuracyMeters` (≥0 or `null`
when unknown), `timestampMs`, `timestampSource` (`host` = the phone reported the fix time;
`received` = WebView receipt time), optional `speedMps`, `headingDegrees`.

`MotionSummary`: `windowStartMs`, `windowEndMs`, `sampleCount`, `units: "sdk_raw"`,
`statistics` (null exactly when `sampleCount = 0`: `magnitude {mean,min,max,stdDev}`,
`maxSampleDelta`, `axisRange {x,y,z}`), `observations[]` (≤ 20; `kind` ∈ `abrupt_change`,
`sustained_high_motion`, `stillness_after_motion`, `irregular_motion`, `sensor_gap`; `atMs`;
optional `durationMs`, `magnitude`; factual `detail` ≤ 200 chars), `quality`
(`level` none/poor/fair/good, `effectiveSampleRateHz`, `longestGapMs`, `notes[]`).

Responses (`CreateAlertResponseSchema`: `{ alert: AlertRecord, created: boolean }`):

- `201` with `created: true` for a new alert;
- `200` with `created: false` when `clientAlertId` was already used. The original alert is
  returned unchanged (first write wins) and **nothing is re-sent**.

The response returns once the alert is persisted. Notification progress is reported through
events, not this response. Initial messages are dispatched immediately; AI analysis never
delays them.

`AlertRecord`:

| Field                                                               | Type                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `alertId`, `clientAlertId`, `activatedAt`, `createdAt`, `updatedAt` |                                                                                                                         |
| `state`                                                             | `received` \| `notifying` \| `notified` \| `notification_failed`                                                        |
| `location`                                                          | `LocationFix` \| null                                                                                                   |
| `recipients[]`                                                      | `{ contactId, displayName, status, updatedAt, failureCode }`, the initial SOS per eligible contact                      |
| `initialAcceptedCount`                                              | recipients with status `photon_accepted`, `delivery_unconfirmed`, or `delivered`                                        |
| `initialDeliveredCount`                                             | recipients with status `delivered`                                                                                      |
| `totalRecipients`                                                   | = `recipients.length`                                                                                                   |
| `aiAnalysis`                                                        | `{ status: pending\|running\|completed\|insufficient_information\|failed\|skipped, updatedAt }`                         |
| `recording`                                                         | `{ status: not_started\|receiving\|finalizing\|completed\|failed, recordingId, durationMs, notificationAcceptedCount }` |
| `latestEventCursor`                                                 | string \| null                                                                                                          |

#### Notification statuses (Photon 2.0 mapping)

| Haven `status`         | Photon 2.0                              | Meaning (use this wording on the HUD)                 |
| ---------------------- | --------------------------------------- | ----------------------------------------------------- |
| `queued`               | (not yet submitted)                     | Sending...                                            |
| `photon_accepted`      | `202`, status `dispatched`              | Accepted by Photon. Delivery not confirmed yet.       |
| `delivery_unconfirmed` | `message.accepted` (terminal)           | Accepted by the carrier. Delivery can't be confirmed. |
| `delivered`            | `message.delivered` (terminal)          | Delivered                                             |
| `failed`               | non-2xx, or `message.failed` (terminal) | Failed (`failureCode`, e.g. `recipient_unreachable`)  |

Photon's own word "accepted" means delivery **could not** be confirmed. Haven's
"photon_accepted" means Photon took the message. Never show either as "delivered".

### `GET /api/v1/alerts/:alertId`

`200` `AlertRecord`. `404` if unknown. `400` for a malformed ID.

### `GET /api/v1/alerts/:alertId/events?cursor=<cursor>&limit=<1..100>`

Ordered, resumable event feed. Poll it (e.g. every 1–2 s during an active alert).

- `cursor`: return events **strictly after** this cursor; omit it to start from the beginning.
- `limit`: default 50, max 100.

`200` (`AlertEventsPageSchema`):

```json
{
  "events": [
    {
      "id": 41,
      "alertId": "alt_3k9x0q8m2c7v4b1n6z5r8t0w",
      "timestampMs": 1792314852010,
      "type": "alert.initial_notification_accepted",
      "payload": { "acceptedCount": 1, "totalRecipients": 2 }
    }
  ],
  "nextCursor": "41",
  "hasMore": false
}
```

- IDs are strictly increasing (SQLite `AUTOINCREMENT`). Each event is delivered once per cursor
  position, so polling with `nextCursor` never skips or repeats.
- `nextCursor` is the last returned event's cursor, or the request's cursor when nothing is new.
- `hasMore: true` means the page was full: poll again immediately.
- Treat cursors as opaque strings.

#### Event types (`AlertEventSchema`)

| `type`                                | `payload`                                                                                          | Meaning                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `sos.received`                        | `clientAlertId, activatedAt, hasLocation, hasMotionSummary, totalRecipients`                       | SOS persisted; nobody contacted yet                                                 |
| `notification.photon_accepted`        | `kind, contactId, displayName, status, failureCode`                                                | Photon took one message (`kind`: `initial_sos`, `context_update`, `recording_link`) |
| `notification.delivery_unconfirmed`   | same                                                                                               | Provider accepted; delivery can't be confirmed                                      |
| `notification.delivered`              | same                                                                                               | Provider confirmed delivery                                                         |
| `notification.failed`                 | same                                                                                               | Will not be delivered                                                               |
| `alert.initial_notification_accepted` | `acceptedCount ≥ 1, totalRecipients`                                                               | **First** initial SOS accepted → G2 starts recording                                |
| `alert.initial_notification_failed`   | `reason: no_eligible_contacts \| all_sends_failed \| provider_unavailable, totalRecipients`        | No SOS message went out                                                             |
| `context.completed`                   | `result: ContextResult`                                                                            | AI context ready (sent as a separate message)                                       |
| `context.insufficient_information`    | `result: ContextResult`                                                                            | Not enough evidence; SOS unaffected                                                 |
| `context.failed`                      | `reason: timeout \| provider_error \| invalid_output \| not_configured`                            | SOS unaffected                                                                      |
| `contact.responded`                   | `contactId, displayName, text (≤ 500), receivedAt`                                                 | Authenticated reply; show as `<displayName>: <text>`                                |
| `recording.started`                   | `recordingId`                                                                                      | First audio chunk stored                                                            |
| `recording.upload_completed`          | `recordingId, durationMs, chunkCount, byteLength`                                                  | WAV assembled                                                                       |
| `recording.notification_accepted`     | `recordingId, acceptedCount ≥ 1, totalRecipients`                                                  | Recording link accepted by Photon for ≥ 1 contact                                   |
| `recording.failed`                    | `recordingId \| null, reason: missing_chunks \| storage_error \| notification_failed \| too_large` |                                                                                     |

`ContextResult`: `locationDescription` (≤ 280 or null), `motionObservations[]` (≤ 5, ≤ 200 each),
`possibleContext` (≤ 400 or null, hedged), `uncertainty` low/medium/high,
`evidenceQuality` insufficient/limited/adequate, `model`, `generatedAt`.

### `POST /api/v1/alerts/:alertId/audio/chunks?recordingId=<uuid>&index=<n>&sha256=<hex>`

Upload one chunk of raw PCM (`Content-Type: application/octet-stream`).

- Audio format: 16 kHz, signed 16-bit little-endian, mono (`G2_PCM_FORMAT`; 32,000 bytes/s).
- Body: 1 byte to 256 KiB (`MAX_AUDIO_CHUNK_BYTES`). `index` is 0..999.
- `sha256`: lowercase hex SHA-256 of the body.
- **Retry-safe**: the same `(recordingId, index, sha256)` → `200` `duplicate`; the same index
  with a different hash → `409`. A body whose hash does not match `sha256` → `400`.

`201` / `200` (`UploadAudioChunkResponseSchema`):
`{ "recordingId": "...", "index": 3, "status": "stored" | "duplicate", "receivedChunkCount": 4 }`

### `POST /api/v1/alerts/:alertId/audio/complete`

Finalize the recording and notify contacts (`CompleteAudioRequestSchema`):

```json
{ "recordingId": "8a1f...", "chunkCount": 12, "durationMs": 37500, "startedAt": 1792314853000 }
```

- Requires chunks `0..chunkCount-1`; otherwise `409` with the missing indexes in the message.
- Assembles a WAV, creates a 7-day secure link, and sends it through
  `HavenNotificationService.sendRecordingNotification`.
- **Idempotent per `recordingId`**: a retry returns the same result and never re-notifies.

`200` (`CompleteAudioResponseSchema`):
`{ "recording": AudioRecordingMetadata, "notification": { "acceptedCount": 2, "totalRecipients": 2 } }`

`AudioRecordingMetadata`: `alertId, recordingId, mimeType ("audio/wav"), durationMs, chunkCount,
byteLength, status (receiving|finalizing|completed|failed), createdAt, completedAt`.

### `POST /api/v1/photon/webhooks` (public, Photon-signed)

Photon 2.0 webhook destination. Not called by the G2 app.

- The handler receives the **exact raw body** and lowercased headers (`PhotonWebhookRequest`).
- It must verify the signature with `PHOTON_WEBHOOK_SECRET` and reject failures with `401`. The
  Beta docs do not document the header format; confirm it against a real delivery first.
- Dedupe by Photon event ID (`pho_evt_...`, table `webhook_receipts`); duplicates return `200` `duplicate`.
- Relevant event types (API version `2026-07-01`): `message.received` (contact replies and
  opt-ins), `message.accepted`, `message.delivered`, `message.failed`.
- A reply from a configured contact during an active alert becomes `contact.responded`. A first
  message from a `pending` contact marks it `verified`. STOP marks it `revoked`.
- `200` `{ "status": "processed" | "duplicate" | "ignored" }`.

In mock mode, Agent 2 provides an equivalent signed-payload path for simulating replies locally.

### `GET /r/:token` (public capability URL)

Streams a finalized recording to an emergency contact.

- `token`: 20–128 URL-safe characters; only its SHA-256 is stored; expires after 7 days.
- `200` audio body with `Content-Type: audio/wav`, `Cache-Control: private, no-store`,
  `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`.
- `404` for unknown, expired, or revoked tokens. It never reveals which.

## Constants

| Name                              | Value                   | Where              |
| --------------------------------- | ----------------------- | ------------------ |
| `SOS_COUNTDOWN_MS`                | 5000                    | client-state.ts    |
| `DEFAULT_CLICK_DISAMBIGUATION_MS` | 400 (provisional)       | g2 core/input      |
| `EMERGENCY_SNAPSHOT_TIMEOUT_MS`   | 1500                    | g2 core/interfaces |
| `MAX_EMERGENCY_CONTACTS`          | 5                       | contacts.ts        |
| `LOCATION_STALE_AFTER_MS`         | 120000                  | location.ts        |
| `MOTION_SUMMARY_WINDOW_MS`        | 60000                   | motion.ts          |
| `CONTEXT_ANALYSIS_TIMEOUT_MS`     | 10000                   | context.ts         |
| `HAVEN_LLM_MODEL`                 | `gemini-2.5-flash-lite` | context.ts         |
| `SESSION_TTL_MS`                  | 30 days                 | auth.ts            |
| `MAX_AUDIO_CHUNK_BYTES`           | 262144                  | recording.ts       |
| `MAX_AUDIO_CHUNKS`                | 1000                    | recording.ts       |
| `MAX_RECORDING_DURATION_MS`       | 10 minutes              | recording.ts       |
| `RECORDING_SHARE_LINK_TTL_MS`     | 7 days                  | recording.ts       |
