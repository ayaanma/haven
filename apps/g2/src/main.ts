// Owner: Agent 1. Initial bootstrap created by the foundation commit.
//
// Startup order matters: the SDK bridge must be ready, then the blank event-capturing HUD
// is created (createHavenAppContext does both) before any other glasses call.
import { createHavenAppContext } from "./core/app-context";
import { createLog, READY_MARKER } from "./core/log";
import { mountBridgeUnavailable, mountOnboarding } from "./onboarding";
import { startHavenWorkflow } from "./workflows";

const log = createLog("main");
const root = document.querySelector<HTMLElement>("#app");

async function start() {
  if (!root) throw new Error("#app root element missing");
  try {
    const ctx = await createHavenAppContext();
    mountOnboarding(root, ctx);
    startHavenWorkflow(ctx);
    await ctx.devices.startSensorCollection();
    // scripts/sim-smoke.mjs waits for this exact line.
    console.info(READY_MARKER, { apiBaseUrl: ctx.config.apiBaseUrl });
  } catch (error) {
    log.error("startup failed", String(error));
    mountBridgeUnavailable(root, error instanceof Error ? error.message : String(error));
  }
}

void start();
