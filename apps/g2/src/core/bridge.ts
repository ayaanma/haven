import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * The subset of the Even Hub SDK bridge (SDK 0.0.16) that Haven uses. Feature code
 * depends on this type, never on the singleton, so tests can pass a FakeBridge.
 * Need another bridge method? Propose adding it here (foundation-owned).
 */
export type HavenBridge = Pick<
  EvenAppBridge,
  | "createStartUpPageContainer"
  | "rebuildPageContainer"
  | "textContainerUpgrade"
  | "shutDownPageContainer"
  | "onEvenHubEvent"
  | "audioControl"
  | "imuControl"
  | "getAppLocation"
  | "startAppLocationUpdates"
  | "stopAppLocationUpdates"
  | "onAppLocationChanged"
  | "getLocalStorage"
  | "setLocalStorage"
  | "getDeviceInfo"
  | "onDeviceStatusChanged"
  | "onLaunchSource"
>;

export class BridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/**
 * Resolve the Even App bridge. Calling SDK methods before the bridge is ready silently
 * no-ops (SDK docs), so everything else waits on this. Outside the Even Realities app
 * (a plain browser) the bridge may resolve but every call fails; createBlankHud reports that.
 */
export async function connectBridge(timeoutMs = 10_000): Promise<HavenBridge> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BridgeUnavailableError(`Even App bridge not ready after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([waitForEvenAppBridge(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
