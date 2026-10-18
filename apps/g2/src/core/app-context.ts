// G2 composition root (foundation-owned). The only file that imports every module's
// factory. Agents implement their factory in their own directory and do not edit this.
import { createAudioService } from "../audio";
import { createDeviceService } from "../devices";
import { createApiClient } from "../services/api-client";
import { createBlankHud } from "./bootstrap";
import { connectBridge, type HavenBridge } from "./bridge";
import { loadG2Config, type G2Config } from "./config";
import { createHttpClient, type HavenHttpClient } from "./http";
import { createSdkInputController, type SdkInputController } from "./input";
import type { HavenApiClient, HavenAudioService, HavenDeviceService } from "./interfaces";
import { createLog, type Log } from "./log";
import { browserScheduler, type Scheduler } from "./scheduler";
import { createBridgeStorage, createSessionStore, type SessionStore } from "./session-store";

export interface HavenAppContext {
  config: G2Config;
  bridge: HavenBridge;
  scheduler: Scheduler;
  log: Log;
  sessions: SessionStore;
  http: HavenHttpClient;
  input: SdkInputController;
  devices: HavenDeviceService;
  audio: HavenAudioService;
  api: HavenApiClient;
  dispose(): Promise<void>;
}

/**
 * Connect to the Even App, draw the blank event-capturing HUD, and build every service.
 * Rejects with BridgeUnavailableError outside the Even Realities app / simulator.
 */
export async function createHavenAppContext(
  overrides: { config?: G2Config; scheduler?: Scheduler } = {},
): Promise<HavenAppContext> {
  const config = overrides.config ?? loadG2Config();
  const scheduler = overrides.scheduler ?? browserScheduler;
  const log = createLog("app");

  const bridge = await connectBridge();
  await createBlankHud(bridge);

  const sessions = createSessionStore(createBridgeStorage(bridge), () => scheduler.now());
  const http = createHttpClient({ baseUrl: config.apiBaseUrl, sessions });
  const input = createSdkInputController(bridge, {
    scheduler,
    clickDisambiguationMs: config.clickDisambiguationMs,
    log: createLog("input"),
  });
  const devices = createDeviceService({ bridge, scheduler, log: createLog("devices") });
  const audio = createAudioService({ bridge, http, scheduler, log: createLog("audio") });
  const api = createApiClient({ http, sessions });

  return {
    config,
    bridge,
    scheduler,
    log,
    sessions,
    http,
    input,
    devices,
    audio,
    api,
    async dispose() {
      input.dispose();
      await Promise.allSettled([audio.disposeRecording(), devices.stopSensorCollection()]);
    },
  };
}
