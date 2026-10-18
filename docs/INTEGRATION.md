# Integration guide

How the four agents' modules connect, what each one must provide, how to test without
waiting for the others, and how to change a shared contract.

## The seams

Every cross-module call goes through an interface defined by the foundation:

| Interface                  | File                             | Implemented by            | Called by                                     |
| -------------------------- | -------------------------------- | ------------------------- | --------------------------------------------- |
| `HavenInputController`     | `apps/g2/src/core/interfaces.ts` | foundation (`core/input`) | Agent 1 workflows                             |
| `HavenDeviceService`       | `apps/g2/src/core/interfaces.ts` | Agent 3                   | Agent 1 (startup, SOS)                        |
| `HavenAudioService`        | `apps/g2/src/core/interfaces.ts` | Agent 4                   | Agent 1 (RECORDING / UPLOADING_AUDIO)         |
| `HavenApiClient`           | `apps/g2/src/core/interfaces.ts` | Agent 1                   | Agent 1 (workflow, onboarding)                |
| `HavenHttpClient`          | `apps/g2/src/core/http.ts`       | foundation                | Agent 1 (`HavenApiClient`), Agent 4 (uploads) |
| `ContactsService`          | `apps/api/src/lib/interfaces.ts` | Agent 2                   | routes/contacts.ts, alerts                    |
| `AlertService`             | `apps/api/src/lib/interfaces.ts` | Agent 2                   | routes/alerts.ts                              |
| `HavenNotificationService` | `apps/api/src/lib/interfaces.ts` | Agent 2                   | alerts (Agent 2), routes/audio.ts (Agent 4)   |
| `PhotonWebhookHandler`     | `apps/api/src/lib/interfaces.ts` | Agent 2                   | routes/photon-webhooks.ts                     |
| `HavenContextService`      | `apps/api/src/lib/interfaces.ts` | Agent 3                   | alerts (Agent 2)                              |
| `HavenRecordingStorage`    | `apps/api/src/lib/interfaces.ts` | Agent 4                   | routes/audio.ts (Agent 4)                     |
| `EventLog`                 | `apps/api/src/db/event-log.ts`   | foundation                | every backend module                          |

The composition roots, `apps/g2/src/core/app-context.ts` and `apps/api/src/container.ts`, call
one factory per module. They already import every placeholder, so replacing a placeholder's body
needs **no edit outside your directory**.

## Per-agent checklists

### Agent 1: G2 workflow, HUD, onboarding, API client

Implement:

- [ ] `services/api-client.ts`: `createApiClient({ http, sessions })` over
      `http.json(...)` with contract response schemas. `createSession` uses `auth: false` and
      saves the session; `createAlert` retries the **same** request on `error.retryable`.
- [ ] `workflows/`: the state machine in [ARCHITECTURE.md](ARCHITECTURE.md#client-state-machine-agent-1).
      Route every press through `singlePressAction(state)`. Countdown deadline =
      `activation.pressedAtMs + SOS_COUNTDOWN_MS`; a cancel counts when
      `isCancelPressInTime(press.pressedAtMs, deadline)`; submit at
      `deadline + ctx.config.clickDisambiguationMs` after re-checking that no cancel arrived.
      Mint `clientAlertId = crypto.randomUUID()` once per SOS.
- [ ] Event polling with `getAlertEvents(alertId, cursor)`. Start recording on
      `alert.initial_notification_accepted`; go to ERROR on `alert.initial_notification_failed`;
      render `contact.responded` as `"<displayName>: <text>"`.
- [ ] `hud/`: `HUD_COPY` verbatim; a prominent countdown digit; recording timer from
      `audio.onProgress`; provider-accurate status text (see the API_CONTRACTS status table).
- [ ] `onboarding/`: phone-side pairing form, contacts editor (max 5, E.164), consent state
      per contact, and an explanation that each contact must text Haven's line to opt in.
- [ ] Persist active alert ID, clientAlertId, and cursor so an Android cold start resumes.

Test with `FakeInputController`, `MockApiClient`, `MockDeviceService`, `MockAudioService`, and
`ManualScheduler` (`apps/g2/src/testing`). You do not need the backend or the other agents.

### Agent 2: alerts, Photon, contacts, webhooks

Implement:

- [ ] `contacts/`: `ContactsService` on the `contacts` table (rules in API_CONTRACTS `PUT /contacts`).
- [ ] `photon/`: `createNotificationService(ctx)` for mock mode (`mock_outbox`, no network) and
      live mode (Photon 2.0 Beta, see the ARCHITECTURE integration notes). Persist
      `alert_notifications`, append `notification.*` events, and use stable `idempotency-key`s.
      Message text: wearer activated a danger alert and needs help; please call 911 and share
      this location; Google Maps link (`googleMapsUrl`); fix time and accuracy; "last known" if
      older than `LOCATION_STALE_AFTER_MS`; "location unavailable" if missing. Never claim help
      is coming.
- [ ] `photon/`: `createPhotonWebhookHandler(ctx)`: verify signatures, dedupe by event ID,
      map status events to `notification.*`, route replies to `contact.responded` and opt-ins
      to consent, and provide a mock-mode way to simulate replies.
- [ ] `alerts/`: `createAlertService` per the step list in `alerts/index.ts`. The SOS dispatch
      must not await `context.analyzeEmergencyContext`.

Test with `createTestHarness({ overrides: { context: new FakeContextService(...) } })`. A slow
`FakeContextService(outcome, delayMs)` proves the SOS does not wait for AI.

### Agent 3: sensors and AI context

Implement:

- [ ] `apps/g2/src/devices/`: `createDeviceService({ bridge, scheduler, log })`: location cache
      (`startAppLocationUpdates`/`onAppLocationChanged`, `getAppLocation` fallback), an IMU ring
      buffer (`imuControl` + `sysEvent.imuData`, eventType 8), and `MotionSummary` computation.
      `getEmergencySnapshot` resolves within `EMERGENCY_SNAPSHOT_TIMEOUT_MS` and never rejects.
      Re-arm on `foreground_enter` (subscribe through your own `bridge.onEvenHubEvent` listener).
- [ ] `apps/api/src/context/`: live `HavenContextService` (Gemini 2.5 Flash-Lite through the
      OpenAI-compatible endpoint), JSON validated with `ContextResultSchema`, timeout, and
      `insufficient_information` when evidence is thin. The prompt must forbid inventing
      incidents and state that IMU units are raw and uncalibrated.

Test the device service with `FakeBridge` (`emitHostMessage` for IMU samples, `emitLocation`)
and `ManualScheduler`; test context with a stubbed `fetch`.

### Agent 4: audio

Implement:

- [ ] `apps/g2/src/audio/`: `createAudioService({ bridge, http, scheduler, log })`:
      `audioControl(true, AudioInputSource.Glasses)`, collect `event.audioEvent.audioPcm`,
      chunk to ≤ 256 KiB, upload with `http.binary` (query `recordingId`, `index`, `sha256`),
      retry safely, then `http.json` POST `audio/complete`. Report progress via `onProgress`.
- [ ] `apps/api/src/audio/`: `createRecordingStorage(ctx)` on disk under `AUDIO_STORAGE_PATH`
      and the `recordings` / `recording_chunks` / `share_links` tables.
- [ ] `apps/api/src/routes/audio.ts`: finish `audio/complete` (finalize → share link →
      `container.notifications.sendRecordingNotification` → `recording.*` events) and keep the
      chunk/route contracts.

Test with `createTestHarness({ overrides: { notifications: new FakeNotificationService("photon_accepted", [{ contactId }]) } })`
and `seedAlert(h.db)`. You do not need Agent 2's alert service.

## End-to-end local run (once the modules exist)

```sh
cp .env.example .env              # PHOTON_MODE=mock, LLM_MODE=mock
npm run dev:api                   # terminal 1
npm run dev:g2                    # terminal 2
npm run sim                       # terminal 3: Click = single press
```

1. Pair from the phone-side UI (the simulator's webview window) with `HAVEN_PAIRING_CODE`.
2. Add a contact. In mock mode, simulate their opt-in message through the webhook mock path.
3. Click: countdown. Wait 5 s: SOS → `mock_outbox` rows; HUD "SOS sent", then "Recording...".
4. Click: audio uploads; the recording link message lands in `mock_outbox`.
5. Simulate a reply: the HUD shows `"<name>: <text>"`.

Inspect the database with `sqlite3 data/haven.db 'select * from alert_events'` (any SQLite client).

## Merge order and milestones

Modules are independent behind their interfaces, so agents merge whenever CI is green. A useful
order for the demo:

1. Agent 2 contacts + mock notifications + alerts → backend SOS works end to end in mock mode.
2. Agent 1 workflow against `MockApiClient`, then against the real backend.
3. Agent 3 devices (location first, then IMU), then live context.
4. Agent 4 audio capture + upload + link.
5. Live Photon with consenting test contacts only (HARDWARE_TEST_PLAN H12).

## Proposing a contract change

Foundation files (contracts, interfaces, composition roots, migrations, configs, package.json,
docs) do not change in feature branches. When you hit a gap:

1. **Work within the current contract** if you can (e.g. extra data inside your own tables or
   modules).
2. Otherwise open a GitHub issue titled `contract: <short description>` with:
   - the file and symbol to change, and the exact proposed diff;
   - why the current contract blocks you;
   - who is affected (which agents' code must change);
   - whether it is backward compatible (adding optional fields usually is; renames are not).
3. Leave a `// CONTRACT-PROPOSAL(#issue): ...` comment at the workaround in your own code.
4. The foundation owner applies the change in a separate `chore(contracts): ...` commit on
   `main`; then everyone rebases.

Never fork a contract locally (for example by redefining a schema inside your module). Two
diverging definitions are the integration bug this process exists to prevent.
