# Deploying Haven to production

Haven has two deployable parts:

1. **The API** (`apps/api`): a long-running Node 24 process with a SQLite database and audio
   files on disk. It holds every secret and is the only thing that talks to Photon and Gemini.
2. **The G2 plugin** (`apps/g2`): a static web app packaged as an `.ehpk` and installed through
   Even Hub. It contains no secrets and only calls the API it was built for.

## 1. Choose a host for the API

The API needs:

- an **always-on process** (retries, recovery, and webhooks run in the background);
- a **persistent disk** mounted at `/data` (SQLite database and recordings);
- a public **HTTPS** URL (Photon webhooks and the recording links contacts open).

Any container host with a volume works: Fly.io, Railway, Render, or a VM. Serverless functions
(e.g. Vercel Functions) do **not** fit: there is no persistent disk and no long-lived process.
Run **one instance**: SQLite and the in-memory retry timers assume a single writer.

The repo root `Dockerfile` builds the image (non-root, health-checked, data under `/data`):

```sh
docker build -t haven-api .
docker run -d -p 8787:8787 -v haven-data:/data --env-file .env.production haven-api
```

Back up `/data/haven.db` (plus `-wal`) and `/data/recordings` on the host's schedule.

## 2. Photon 2.0 (Beta)

In https://app.beta.photon.codes for your project:

1. **API key**: Settings → API keys → New API key with `project:read`, `project:write`,
   `platforms:read`, `platforms:write` (the last two let Haven assign shared lines to contacts).
2. **Line mode**:
   - `PHOTON_LINE_MODE=shared` (default, pooled iMessage lines): Haven creates a shared-line
     assignment for every emergency contact (one plan seat each). Photon may give each contact
     a **different** Haven number; the phone UI shows it next to each contact as the number to
     text. A contact can only receive alerts after texting that number.
   - `PHOTON_LINE_MODE=dedicated` (one project-owned line): set `PHOTON_AGENT_USER_ID` (the
     line's `pho_usr_...`) and `PHOTON_LINE_NUMBER` (its number).
3. **Webhook** (after the API is reachable over HTTPS):

   ```sh
   npm run photon:webhook -w @haven/api -- create https://<your-api-host>
   ```

   It prints `PHOTON_WEBHOOK_SECRET=whsec_...` once: set it on the server and restart.
   (`list`, `update <id> <origin>`, and `disable <id>` manage existing destinations.)

## 3. Production environment

| Variable                   | Value                                                                   |
| -------------------------- | ----------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`          | `https://<your-api-host>` (recording links use it)                      |
| `HAVEN_PAIRING_CODE`       | a unique code, at least 12 characters (the wearer types it once)        |
| `HAVEN_WEARER_NAME`        | the wearer's name as contacts know it, e.g. `Jaden`                     |
| `PHOTON_MODE`              | `live`                                                                  |
| `PHOTON_API_KEY`           | `pho_sk_...`                                                            |
| `PHOTON_PROJECT_ID`        | `pho_prj_...`                                                           |
| `PHOTON_LINE_MODE`         | `shared` or `dedicated` (see above)                                     |
| `PHOTON_WEBHOOK_SECRET`    | `whsec_...` from step 2.3                                               |
| `LLM_MODE` / `LLM_API_KEY` | `live` and a Gemini API key (optional; the SOS never depends on it)     |
| `ALLOWED_ORIGINS`          | `*` until the packaged WebView origin is known (HARDWARE_TEST_PLAN H11) |

`DATABASE_PATH`, `AUDIO_STORAGE_PATH`, and `PORT` are preset in the image. The server refuses
to start in live mode with a missing key, a non-HTTPS `PUBLIC_BASE_URL`, or a weak pairing code.

Gemini note: Google limits `gemini-2.5-flash-lite` to projects that used 2.5 models before; a
new key may get 404. Haven then sends no AI follow-up and everything else works.

## 4. Build and publish the G2 plugin

```sh
VITE_HAVEN_API_BASE_URL=https://<your-api-host> npm run pack:g2
```

The packaged manifest's network whitelist is set to that origin only. Upload the `.ehpk` through
the Even Hub developer portal.

## 5. Go-live verification (consenting testers only)

1. `GET https://<your-api-host>/healthz` → `{"status":"ok","photonMode":"live",...}`.
2. Pair the phone, add one consenting tester. With shared lines, their contact row shows the
   number to text; ask them to text it.
3. **Webhook signature (required once).** Photon has not documented its signature headers;
   Haven verifies the Standard Webhooks scheme and rejects anything else. In the API logs:
   - `"webhook handled"` → verification works; the tester shows as verified.
   - `"webhook rejected"` → the log lists the signature header names Photon sent; adjust
     `apps/api/src/photon/signature.ts` to match, redeploy, and have the tester text again.
4. Trigger an SOS on the glasses (HARDWARE_TEST_PLAN H12): the tester receives the SOS, the HUD
   shows "SOS sent" and starts recording, the recording link arrives, and their reply shows on
   the HUD.
5. Work through the rest of `docs/HARDWARE_TEST_PLAN.md` (press timing H2–H3, IMU H8,
   background behavior H10, packaged networking H11, microphone H13) on real hardware.

## Operational notes

- Logs are JSON lines without phone numbers, coordinates, message text, or tokens.
- Contacts can text STOP to opt out (Haven never messages them again) and START to opt back in.
- Each phone number receives at most 30 Haven messages per hour.
- Removing a contact or changing their number releases their shared-line seat.
