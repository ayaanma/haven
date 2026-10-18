# haven

a personal safety application built for the even realities G2. built for ucla's 2026 ai hackathon.

---

Haven is an [Even Hub](https://hub.evenrealities.com/docs/) plugin for the Even Realities G2
glasses. While Haven is the active plugin, the HUD stays blank. One **single press** starts a
5-second countdown ("Are you in danger?"). Another single press cancels it. If the countdown
runs out, Haven texts the wearer's chosen emergency contacts through
[Photon 2.0](https://photon.codes/docs/beta/) with the wearer's location, then records audio
from the glasses. Contacts can reply from their normal messaging apps, and their replies
appear on the HUD.

Haven never contacts 911 or the police directly. It asks the emergency contacts to call 911.

> **Status: foundation commit.** This commit sets up the shared contracts, wiring, auth,
> database, test infrastructure, and Even Hub packaging. Four feature agents build the rest in
> parallel (see [AGENTS.md](AGENTS.md)). Until they land, feature endpoints answer
> `501 not_implemented` and the G2 app only logs presses.

## Quick start

Requires **Node.js 24** (`.nvmrc`) and npm 11.

```sh
npm install
cp .env.example .env          # mock mode by default: nobody is ever contacted
npm run dev:api               # Haven API on http://localhost:8787
npm run dev:g2                # G2 app (Vite) on http://localhost:5173
npm run sim                   # Even Hub simulator pointed at the dev server
```

In the simulator window: **Click** is a single press, **Double Click** opens the system exit
dialog.

## Scripts

| Command                                     | What it does                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run verify`                            | lint, typecheck, test, build: run before every push                           |
| `npm run lint`                              | ESLint (including the cross-agent import boundaries) and the Prettier check   |
| `npm run typecheck`                         | `tsc` in every workspace                                                      |
| `npm run test`                              | Vitest across all workspaces (`--project contracts\|api\|g2\|repo` to narrow) |
| `npm run build`                             | API bundle (`apps/api/dist`) and G2 web build (`apps/g2/dist`)                |
| `npm run dev:api` / `npm run dev:g2`        | Watch-mode backend / Vite dev server                                          |
| `npm run sim`                               | `evenhub-simulator http://localhost:5173`                                     |
| `npm run sim:smoke`                         | Headless simulator check: boots, blank HUD, single press, double-press exit   |
| `npm run qr -w @haven/g2`                   | QR code to sideload the dev server onto real glasses                          |
| `npm run pack:g2`                           | Build + `evenhub pack` → `apps/g2/haven-<version>.ehpk`                       |
| `npm run check:ownership -- --agent agent2` | Fails if your branch touches files your agent does not own                    |

## Repository layout

```
apps/
  g2/            Even Hub plugin (Vite + TypeScript + @evenrealities/even_hub_sdk 0.0.16)
    app.json     Even Hub manifest (permissions: network, location, g2-microphone)
    src/core/    foundation: bridge, blank HUD bootstrap, input normalization, HTTP, sessions
    src/{hud,workflows,services,onboarding}/   Agent 1
    src/devices/ Agent 3      src/audio/   Agent 4
  api/           Hono backend on Node 24 with SQLite (node:sqlite)
    src/{app,container,index}.ts, lib/, db/, routes/auth.ts   foundation
    src/{alerts,photon,contacts}/, routes/{alerts,contacts,photon-webhooks}.ts   Agent 2
    src/context/ Agent 3      src/audio/, routes/audio.ts   Agent 4
packages/
  contracts/     Zod schemas + types shared by both apps (foundation)
docs/            product spec, architecture, API contracts, integration, hardware test plan
scripts/         ownership map and checker
```

## Safety defaults

- `PHOTON_MODE=mock` and `LLM_MODE=mock` are the defaults. Mock mode makes no network calls
  and contacts no one.
- Photon and Gemini keys live only on the server. The G2 bundle holds no secrets.
- Only contacts who opted in by texting Haven's line receive alerts. Photon's shared iMessage
  lines cannot send the first message anyway.
- Authentication is a hackathon-grade pairing code exchanged for scoped bearer tokens. It is
  not an audited identity system ([ARCHITECTURE.md § Security model](docs/ARCHITECTURE.md#security-model)).

## Documentation

- [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md): the complete user workflow and the rules the product must follow
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, state machines, security, verified platform limits
- [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md): every endpoint, schema, event, and status
- [docs/INTEGRATION.md](docs/INTEGRATION.md): how the four agents' modules connect, and how to propose changes
- [docs/HARDWARE_TEST_PLAN.md](docs/HARDWARE_TEST_PLAN.md): what must be verified on real G2 hardware
- [AGENTS.md](AGENTS.md): rules for the parallel coding agents
