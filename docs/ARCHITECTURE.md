# Haven architecture

## System overview

```
 ┌──────────────┐  Bluetooth   ┌───────────────────────────────┐   HTTPS (Bearer)   ┌──────────────────────────┐
 │  Even G2     │◄────────────►│ Phone: Even Realities app     │◄──────────────────►│ Haven API (Hono, Node 24)│
 │  glasses     │  HUD, input, │  └ WebView: Haven plugin      │  /api/v1/...       │  SQLite (node:sqlite)    │
 │  IMU, mics   │  IMU, PCM    │     (apps/g2, Even Hub SDK)   │                    │  audio files on disk     │
 └──────────────┘              │     phone GPS via SDK         │                    └──────┬─────────────┬─────┘
                               └───────────────────────────────┘                           │             │
                                                                         Photon 2.0 Beta   │             │ OpenAI-compatible
                                                                   api.photon.codes/v1     ▼             ▼ chat completions
                                                                     ┌────────────────────────┐   ┌────────────────────────┐
                                     Emergency contacts ◄───────────►│ Photon (iMessage/SMS)  │   │ Gemini 2.5 Flash-Lite  │
                                     (existing apps)    texts/replies└──────────┬─────────────┘   └────────────────────────┘
                                                                                 │ webhooks (message.received / delivered / failed)
                                                                                 └──────────► POST /api/v1/photon/webhooks
```

- The **G2 app** is a web app hosted in the Even Realities app's WebView (WKWebView on iOS,
  Chromium on Android). It draws the HUD through SDK containers, receives presses, IMU, and mic
  PCM through `bridge.onEvenHubEvent`, and reads phone GPS through `getAppLocation` /
  `onAppLocationChanged`. No app logic runs on the glasses.
- The **API** holds every secret (Photon, Gemini), owns the alert lifecycle, and is the only
  component that talks to Photon and the LLM.
- **Contacts** use their existing messaging apps. Recording links are plain HTTPS URLs.

## Workspaces and ownership

| Workspace                                 | Purpose                                               | Notes                                                                          |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/contracts` (`@haven/contracts`) | Zod schemas + types, constants, HUD copy, press table | Platform-neutral; TypeScript source consumed directly ("just-in-time" package) |
| `apps/g2` (`@haven/g2`)                   | Even Hub plugin                                       | Vite 8, SDK 0.0.16 (exact pin), packaged with `evenhub pack`                   |
| `apps/api` (`@haven/api`)                 | Backend                                               | Hono 4, `@hono/node-server`, `node:sqlite`, bundled by esbuild                 |

Ownership per directory is defined in `scripts/ownership.mjs` and summarized in
[AGENTS.md](../AGENTS.md). Modules depend on interfaces, never on each other:

```
G2:   main.ts ─► core/app-context.ts (composition root)
                   ├─ core/bootstrap, core/input (foundation)
                   ├─ devices/  createDeviceService(deps): HavenDeviceService   (Agent 3)
                   ├─ audio/    createAudioService(deps):  HavenAudioService    (Agent 4)
                   └─ services/ createApiClient(deps):     HavenApiClient       (Agent 1)
                 workflows/, hud/, onboarding/ consume HavenAppContext          (Agent 1)

API:  index.ts ─► container.ts (composition root) ─► app.ts (routes)
                   ├─ contacts/  createContactsService(ctx)                     (Agent 2)
                   ├─ photon/    createNotificationService(ctx), createPhotonWebhookHandler(ctx) (Agent 2)
                   ├─ context/   createContextService(ctx): HavenContextService (Agent 3)
                   ├─ alerts/    createAlertService(ctx, {contacts, notifications, context}) (Agent 2)
                   └─ audio/     createRecordingStorage(ctx): HavenRecordingStorage (Agent 4)
```

`ServiceContext` = `{ config, db, clock, logger, events }`. ESLint `no-restricted-imports`
rules (`eslint.config.js`) reject cross-module imports.

## SOS sequence

```
t=0      single press ─► input controller holds it 400 ms (double-press disambiguation)
t≈0.4s   single_press(pressedAtMs=0) ─► IDLE→COUNTDOWN, HUD shows question + "5"
t=5.0s   countdown deadline = pressedAtMs + 5000
t≈5.4s   deadline + disambiguation window passed with no earlier cancel press
         COUNTDOWN→SUBMITTING_SOS: getEmergencySnapshot() (≤1.5 s, never rejects)
         POST /api/v1/alerts {clientAlertId, activatedAt, location?, motionSummary?}
             backend: persist (idempotent on clientAlertId) → event sos.received
             backend: sendInitialSOS → Photon sendMessage per eligible contact (Idempotency-Key)
             backend: per-contact notification.photon_accepted / .failed
             backend: first acceptance → alert.initial_notification_accepted
             backend (async, after): analyzeEmergencyContext → context.* → sendContextUpdate
         SUBMITTING_SOS→WAITING_FOR_PHOTON; G2 polls GET /alerts/:id/events?cursor=
on alert.initial_notification_accepted:
         WAITING_FOR_PHOTON→RECORDING: audio.startRecording(alertId) automatically,
         HUD "SOS sent (accepted by Photon n/m)", "Recording... 0:07", "Click to send audio"
single press while RECORDING:
         RECORDING→UPLOADING_AUDIO: stopAndSendRecording → chunks → /audio/complete
             backend: finalize WAV → share link → sendRecordingNotification → recording.* events
         UPLOADING_AUDIO→ACTIVE_ALERT
ACTIVE_ALERT: keep polling; render contact.responded as "<name>: <text>"
```

On `alert.initial_notification_failed` the client goes to ERROR and says so on the HUD
("No message could be sent"), with no recording and no false "SOS sent".

### Client state machine (Agent 1)

| From               | Trigger                                                          | To                                    |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------- |
| IDLE               | single press                                                     | COUNTDOWN                             |
| COUNTDOWN          | single press with `pressedAtMs < deadline`                       | IDLE (cancelled)                      |
| COUNTDOWN          | `deadline + clickDisambiguationMs` elapsed                       | SUBMITTING_SOS                        |
| SUBMITTING_SOS     | POST /alerts succeeded                                           | WAITING_FOR_PHOTON                    |
| SUBMITTING_SOS     | retryable error: retry the **same** request (same clientAlertId) | SUBMITTING_SOS                        |
| SUBMITTING_SOS     | non-retryable error, or retries exhausted                        | ERROR                                 |
| WAITING_FOR_PHOTON | event `alert.initial_notification_accepted`                      | RECORDING                             |
| WAITING_FOR_PHOTON | event `alert.initial_notification_failed`                        | ERROR                                 |
| RECORDING          | single press                                                     | UPLOADING_AUDIO                       |
| UPLOADING_AUDIO    | stopAndSendRecording resolved (ok or not)                        | ACTIVE_ALERT                          |
| ERROR              | explicit reset (phone-side control, or app relaunch)             | IDLE                                  |
| any                | double press                                                     | (system exit dialog; state unchanged) |

Persist the active alert ID, clientAlertId, and event cursor in local storage so an Android
WebView cold start can resume polling instead of starting a second SOS.

### Server alert lifecycle (Agent 2)

`received → notifying → notified | notification_failed`. Statuses never regress. `notified`
means at least one initial message was **accepted**, not delivered. Delivery is tracked per
contact (`delivered` / `delivery_unconfirmed` / `failed`) from Photon status webhooks.

## Input pipeline (foundation, `apps/g2/src/core/input`)

1. **Bridge**: `bridge.onEvenHubEvent` delivers SDK-parsed `EvenHubEvent`s.
2. **Normalize** (`normalize.ts`), in this order:
   1. no `textEvent`/`sysEvent` envelope → not a press (audio, list, menu, empty);
   2. IMU sample (`imuData` present or `eventType === 8`) → not a press;
   3. `DOUBLE_CLICK_EVENT (3)` → double press; lifecycle `4–7` → lifecycle;
   4. long press `9/10` and scroll `1/2` → ignored;
   5. `CLICK_EVENT (0)` explicit, **or `eventType` omitted**: CLICK is the protobuf default
      value, so the host drops it and the SDK passes `undefined` through → press candidate.
      Text events for other containers are ignored.
3. **Disambiguate** (`disambiguator.ts`): a candidate is held for **400 ms**
   (`DEFAULT_CLICK_DISAMBIGUATION_MS`, provisional until hardware test H3). A double press in
   that window cancels it. Duplicate candidates for one physical press (textEvent + sysEvent) are
   merged. Candidates within 600 ms after a double press are dropped. Lifecycle exits drop held
   candidates.
4. **Controller** (`controller.ts`): emits `single_press` (with raw `pressedAtMs`),
   `double_press`, and `lifecycle`; on double press it calls `shutDownPageContainer(1)` (the
   system exit dialog Even Hub QA requires on the root page).

Startup (`bootstrap.ts`) creates one full-canvas (576×288) text container,
`containerID 1 / "haven-hud"`, `isEventCapture: 1`, content `" "` (draws no pixels). HUD
updates use `textContainerUpgrade` on that container.

## Persistence (SQLite, `apps/api/src/db/migrations.ts`)

| Table                            | Owner      | Purpose                                                                        |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `sessions`                       | foundation | Wearer sessions; SHA-256 of token, scopes, expiry                              |
| `contacts`                       | Agent 2    | Contacts, consent status, Photon user/space/line IDs, shared-line assignment   |
| `alerts`                         | Agent 2    | One row per SOS; `client_alert_id UNIQUE` backs idempotency                    |
| `alert_notifications`            | Agent 2    | Per (alert, contact, kind) message status; contact snapshot; Photon message ID |
| `alert_events`                   | foundation | Append-only event log; `AUTOINCREMENT` IDs are the cursors                     |
| `inbound_messages`               | Agent 2    | Contact messages from verified webhooks                                        |
| `webhook_receipts`               | Agent 2    | Processed Photon event IDs (dedupe of at-least-once delivery)                  |
| `recordings`, `recording_chunks` | Agent 4    | Audio metadata and per-chunk SHA-256 (retry safety)                            |
| `share_links`                    | Agent 4    | SHA-256 of recording tokens, expiry, access counters                           |
| `mock_outbox`                    | Agent 2    | What mock mode would have sent                                                 |

`node:sqlite` (built into Node 24) avoids native addons. WAL mode, foreign keys on,
`busy_timeout` 5 s. All queries are parameterized. Schema changes are new migrations,
proposed through the foundation.

## Security model

Hackathon-grade, single wearer per deployment. **Not an audited identity system.**

| Concern          | Mechanism                                                                                                | Limits                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Enrollment       | `HAVEN_PAIRING_CODE` → `POST /auth/session`; constant-time compare; 10 attempts / 5 min / IP             | One shared code; no per-user accounts                                          |
| Sessions         | 256-bit random `hvn_` bearer token, only SHA-256 stored, 30-day expiry, scopes                           | No refresh or rotation UI; revocation only via DB                              |
| Authorization    | `auth.require(scope)` on contacts, alerts, events, audio                                                 | All wearer scopes are granted together                                         |
| Recording access | 256-bit capability URL `/r/:token`, hashed at rest, 7-day expiry, `no-store`, `noindex`                  | Anyone holding the link can listen, by design, so contacts need no login       |
| Webhooks         | Signature verification with `PHOTON_WEBHOOK_SECRET` (`whsec_...`) and event-ID dedupe                    | Standard Webhooks scheme, verified against a real Photon delivery (2026-10-18) |
| Secrets          | Photon and Gemini keys only in the server env; config summary logs presence flags, not values            | `.env` must never be committed                                                 |
| Transport        | HTTPS required for `PUBLIC_BASE_URL` in live mode; app.json whitelist set to the API origin at pack time | Local dev uses HTTP on the LAN                                                 |
| CORS             | Bearer tokens, no cookies, so `ALLOWED_ORIGINS=*` exposes no credentials; an allowlist is supported      | The packaged WebView origin is undocumented (HARDWARE_TEST_PLAN H11)           |
| Logging          | JSON logs with key-based redaction of phone, coordinates, text, tokens, secrets                          | Redaction is by key name; do not log PII under other keys                      |
| Abuse limits     | 64 KB JSON bodies, 256 KB audio chunks, 1 MB webhooks                                                    | No global rate limiting beyond pairing                                         |

## Integrations

### Photon 2.0 (Beta), Agent 2

- Base `https://api.photon.codes/v1`, `Authorization: Bearer pho_sk_...` (project API key with
  `project:read` + `project:write`). Client: `@photon-ai/api@0.5.0` (pinned; Beta moves fast).
- Flow per contact: `POST /projects/{id}/users` (createOrGetUser `{handle, platform}`) →
  `POST /projects/{id}/spaces` (createOrGetSpace `{participantIds:[agent, contact], platform}`) →
  `POST /projects/{id}/messages` (`{spaceId, senderId: PHOTON_AGENT_USER_ID, content:{type:"text",format:"plain",text}}`
  with a required `idempotency-key` header, e.g. `haven:<alertId>:<contactId>:<kind>`).
- `202` = persisted for asynchronous delivery (`status: dispatched`). Terminal statuses arrive as
  webhook events `message.accepted` (accepted, delivery unconfirmed), `message.delivered`, and
  `message.failed`, plus `message.received` for replies.
- **Shared iMessage lines can send only to peers who have an Assignment and messaged the line
  first.** With `PHOTON_LINE_MODE=shared` (default) Haven creates a shared-line Assignment per
  contact (`POST /projects/{id}/platforms/imessage/assignments`, `platforms:write`); Photon may
  give each contact a different number, exposed as `EmergencyContact.optInNumber`. A contact's
  first inbound message marks them `verified` and teaches Haven that line's agent User ID and
  Space, which become the `senderId`/`spaceId` for their alerts. `dedicated` mode uses one
  `PHOTON_AGENT_USER_ID` for everyone.
- Haven does not use Stable/Spectrum APIs (`spectrum-ts`, `spectrum.photon.codes`).

### Gemini 2.5 Flash-Lite, Agent 3

- OpenAI-compatible chat completions at `LLM_BASE_URL`
  (`https://generativelanguage.googleapis.com/v1beta/openai`), model fixed to
  `gemini-2.5-flash-lite` (config refuses others), JSON output validated with
  `ContextResultSchema`, hard timeout `CONTEXT_ANALYSIS_TIMEOUT_MS` (10 s).
- Inputs are the `EmergencySensorSnapshot` only: location fix, motion summary in raw SDK units,
  and diagnostics. Never audio or contact data.

## Mock mode

| Setting            | Mock behavior                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHOTON_MODE=mock` | No network calls. Messages are written to `mock_outbox` and marked accepted (Agent 2). Contact replies are simulated through the webhook route with a mock signature (Agent 2). |
| `LLM_MODE=mock`    | Always `insufficient_information`; never fabricates context (implemented now).                                                                                                  |
| G2 tests           | `FakeBridge`, `MockApiClient`, `MockDeviceService`, `MockAudioService`.                                                                                                         |

## Failure handling

| Failure                                  | Behavior                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| No location / permission denied          | SOS still sent; message says location unavailable                                                          |
| No IMU samples                           | `motionSummary` omitted or `quality.level: "none"`; AI may report insufficient info                        |
| Network error on POST /alerts            | Retry the identical request (same `clientAlertId`); the backend never double-sends                         |
| Some Photon sends fail                   | Others proceed; per-contact `notification.failed`; recording starts if ≥1 accepted                         |
| All sends fail / no eligible contacts    | `alert.initial_notification_failed` → HUD says no message was sent                                         |
| LLM error / timeout / 404 (model access) | `context.failed`; nothing else changes                                                                     |
| Audio chunk upload fails                 | Retry the same chunk (idempotent by index + SHA-256)                                                       |
| Android WebView suspended                | Mic, location, and sockets stop; on resume, re-arm sensors and resume event polling from the stored cursor |
| Forged or unsigned webhook               | 401, no state change                                                                                       |

## Verified platform constraints and limitations

Verified on 2026-10-18 against installed packages, the simulator, and official docs:

- **Even Hub SDK 0.0.16** (latest; requires Even App ≥ 2.2.10). `evenHubEventFromJson` passes
  an omitted `eventType` through as `undefined`, and an empty `sysEvent` payload still yields a
  `sysEvent` object. This is why "no envelope" and "envelope with omitted type" are handled
  differently. SDK ≤ 0.0.15 could fire `setTimeout`/`setInterval` callbacks repeatedly (fixed in
  0.0.16): countdowns must compare `Date.now()` with an absolute deadline.
- **Simulator 0.9.5**: a click arrives as `sysEvent {eventSource: 1}` (eventType omitted). A
  double click arrives as `sysEvent {eventType: 3, eventSource: 1}` with no preceding click.
  `ShutDownPageContainer` is received but the exit dialog is not drawn into the screenshot. The
  simulator ignores input until an event-capturing container exists, does not emit status
  events, and does not enforce permissions or background lifecycle.
- **Hardware not yet verified**: whether firmware sends a CLICK before DOUBLE_CLICK, the
  firmware double-press window, ring vs temple `eventSource`, IMU units, rate, and axes, and the
  packaged WebView origin. See [HARDWARE_TEST_PLAN.md](HARDWARE_TEST_PLAN.md).
- **Manifest**: permission names `network`, `location`, `g2-microphone` (verified against the
  packaging docs and `evenhub pack` 0.1.14, which stamped `min_app_version 2.2.10`). The network
  whitelist takes full origins only and is not a CORS bypass.
- **Background**: Haven works only while it is the active plugin. Android can suspend the
  WebView under memory pressure (state, mic, location, and sockets are lost); iOS keeps it running.
- **No audio output** and no custom fonts or colors on the glasses (SDK docs): all feedback is text.
- **Photon 2.0 Beta**: webhooks are signed with the Standard Webhooks scheme (`whsec_` secret,
  `webhook-signature` header), verified against a real delivery on 2026-10-18. The client package is days old (0.5.0, 2026-10-16), so expect churn.
- **Gemini 2.5 Flash-Lite**: Google's Gemini API deprecations page lists no shutdown date for
  `gemini-2.5-flash-lite`, but says access to 2.5 models is limited to users who used them
  before, so a key from a new project may be rejected (reported as a 404). Third-party reports say
  Vertex AI retires 2.5 models on 2026-10-20 (unverified; Haven uses the Gemini API, not Vertex).
- **node:sqlite** is still flagged experimental in Node 24 (prints an ExperimentalWarning,
  suppressed in scripts). The `Db` wrapper isolates it if a swap to `better-sqlite3` is needed.
