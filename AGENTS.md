# Haven agent guide

Four coding agents build Haven in parallel on top of the foundation commit. This file is the
contract between you. Read it fully, then read the docs for your area.

Required reading, in order:

1. [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md): what Haven must and must not do
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, plus verified platform limits
3. [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md): exact endpoint, event, and status contracts
4. [docs/INTEGRATION.md](docs/INTEGRATION.md): your module's inputs and outputs, and test harnesses

## Ownership

Source of truth: [`scripts/ownership.mjs`](scripts/ownership.mjs). `npm run check:ownership -- --list` prints it.

| Agent       | Owns                                                                                                                                                                            | Builds                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Agent 1** | `apps/g2/src/main.ts`, `apps/g2/src/hud/**`, `apps/g2/src/workflows/**`, `apps/g2/src/onboarding/**`, `apps/g2/src/services/**`                                                 | SOS state machine, countdown, HUD rendering, event polling, phone-side pairing/contacts UI, `HavenApiClient` |
| **Agent 2** | `apps/api/src/alerts/**`, `apps/api/src/photon/**`, `apps/api/src/contacts/**`, `apps/api/src/routes/{alerts,contacts,photon-webhooks}.ts`                                      | Alert lifecycle, Photon 2.0 messaging (mock + live), contact consent, webhook verification, reply routing    |
| **Agent 3** | `apps/g2/src/devices/**`, `apps/api/src/context/**`                                                                                                                             | Phone location caching, G2 IMU sampling + `MotionSummary`, Gemini 2.5 Flash-Lite context analysis            |
| **Agent 4** | `apps/g2/src/audio/**`, `apps/api/src/audio/**`, `apps/api/src/routes/audio.ts`                                                                                                 | G2 mic capture, chunked retry-safe upload, WAV storage, secure share links, `/r/:token`                      |
| Foundation  | Everything else: `packages/contracts/**`, `apps/g2/src/{core,testing}/**`, `apps/api/src/{lib,db,testing}/**`, composition roots, `app.ts`, `routes/auth.ts`, root config, docs | Shared contracts, wiring, DB, auth, test infrastructure                                                      |

### Rules

- **Edit only files you own.** Before every push, run
  `npm run check:ownership -- --agent agentN` and `npm run verify`.
- **Do not edit foundation files.** That includes `packages/contracts`, `core/interfaces.ts`,
  `lib/interfaces.ts`, `container.ts`, `app-context.ts`, `db/migrations.ts`, `package.json`,
  lockfiles, configs, and docs. If you need a change, follow
  [INTEGRATION.md § Proposing a contract change](docs/INTEGRATION.md#proposing-a-contract-change)
  and work around it with the existing interface until it lands.
- **Do not add dependencies.** `package.json` and the lockfile are foundation-owned. The
  installed set (Zod 4, Hono, `@photon-ai/api` 0.5.0, the Even Hub SDK 0.0.16, Node built-ins)
  covers the MVP. Propose any addition.
- **Talk to other modules only through the interfaces** in `apps/g2/src/core/interfaces.ts` and
  `apps/api/src/lib/interfaces.ts`. ESLint enforces the import boundaries (`npm run lint`).
- **Keep the factory signatures.** Each module exposes one factory that the composition root calls
  (`createDeviceService`, `createAudioService`, `createApiClient`, `createAlertService`, ...). Keep
  its name, parameters, and return type.
- **Work on a branch** named `agentN/<topic>`, rebase on `main` often, and merge only with green CI.

## Product invariants (non-negotiable)

1. **Single press only.** The only gesture is a normal single press. Never use long press.
   Route every press through `singlePressAction(state)` from `@haven/contracts`:

   | State                               | Single press                                    |
   | ----------------------------------- | ----------------------------------------------- |
   | IDLE                                | start the 5 s countdown                         |
   | COUNTDOWN                           | cancel: no contact, no audio, back to blank HUD |
   | SUBMITTING_SOS / WAITING_FOR_PHOTON | ignore                                          |
   | RECORDING                           | stop and send audio (never a new SOS)           |
   | UPLOADING_AUDIO / ACTIVE_ALERT      | ignore                                          |
   | ERROR                               | ignore until an explicit reset                  |

2. **Double press is the platform's exit gesture.** The input controller already calls
   `shutDownPageContainer(1)`. Never treat a double press as cancel or SOS.
3. **The first SOS never waits for AI.** Context analysis runs after the initial messages and
   goes out as a separate message. It is skipped silently if it fails or times out.
4. **Never message 911 or police.** Message only enabled, consented contacts.
5. **Never fabricate.** Show only replies from `contact.responded` events. Never show "help is
   coming". Report Photon acceptance as acceptance, not delivery. AI output must not invent
   incidents.
6. **Mock mode is the default and contacts nobody.** Live Photon code must stay unreachable
   when `PHOTON_MODE=mock`.
7. **No secrets or PII in the G2 bundle or logs.** Photon and Gemini keys stay on the server.
   Do not log phone numbers, coordinates, message text, tokens, or audio.
8. **Gemini 2.5 Flash-Lite only** (`gemini-2.5-flash-lite`). Config rejects any other model.

## Verified platform facts (2026-10-18)

- **Even Hub SDK 0.0.16** (needs Even App ≥ 2.2.10). A click on our text container arrives as
  `sysEvent: { eventSource: 1 }` with **`eventType` omitted** (verified in simulator 0.9.5 and
  with the SDK parser). Double click arrives as `eventType: 3`, with no preceding click in the
  simulator. Hardware behavior is still unverified: see HARDWARE_TEST_PLAN H2–H3.
- Simulator 0.9.5 logs `ShutDownPageContainer` but does not draw the system exit dialog.
- IMU `x/y/z` units and axis orientation are **undocumented**. Treat them as raw SDK units.
- **Photon 2.0 Beta** (`https://api.photon.codes/v1`, Bearer `pho_sk_...`). A shared iMessage
  line can only message people who messaged it first. Send returns 202 with status `dispatched`.
  The webhook signature header format is **not documented**; verify it against a real delivery.
- `gemini-2.5-flash-lite` has no announced Gemini API shutdown date, but Google limits 2.5 models
  to projects that used them before. A new API key may get 404, in which case the SOS still works
  without AI context.

## Tests

- Backend: `createTestHarness()` from `apps/api/src/testing` gives the real app with in-memory
  SQLite, a session token, a fake clock, and module overrides (`FakeNotificationService`,
  `FakeContextService`, `seedAlert`, `seedContact`).
- G2: `FakeBridge` (it runs host messages through the real SDK parser), `ManualScheduler`,
  `MockApiClient`, `MockDeviceService`, `MockAudioService`, `FakeInputController` from
  `apps/g2/src/testing`.
- Fixtures: `@haven/contracts/testing`.
- Put tests next to code (`*.test.ts`) inside your own directories.
