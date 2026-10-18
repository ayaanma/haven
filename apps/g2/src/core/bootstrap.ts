import { CreateStartUpPageContainer, TextContainerProperty } from "@evenrealities/even_hub_sdk";
import { BridgeUnavailableError, type HavenBridge } from "./bridge";

/** Glasses canvas per eye (Even Hub "Display & UI System"). */
export const G2_CANVAS = { width: 576, height: 288 } as const;

/**
 * The one event-capturing text container Haven creates at startup. HUD code updates it
 * with `textContainerUpgrade({ containerID: HUD_CONTAINER.id, containerName: HUD_CONTAINER.name, ... })`.
 * If a layout needs more containers (`rebuildPageContainer`), exactly one must keep
 * `isEventCapture: 1`, or presses stop arriving.
 */
export const HUD_CONTAINER = { id: 1, name: "haven-hud" } as const;

/** Idle HUD content. A single space draws no pixels; whether an empty string is accepted is firmware-dependent. */
export const BLANK_HUD_CONTENT = " ";

/** How long the glasses get to accept the startup page before Haven reports it on the phone. */
export const START_UP_TIMEOUT_MS = 15_000;

const START_UP_RESULT_NAMES: Record<number, string> = {
  1: "invalid parameters",
  2: "oversize",
  3: "out of memory",
};

export function blankHudPage(): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: G2_CANVAS.width,
        height: G2_CANVAS.height,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        containerID: HUD_CONTAINER.id,
        containerName: HUD_CONTAINER.name,
        content: BLANK_HUD_CONTENT,
        isEventCapture: 1,
      }),
    ],
  });
}

/**
 * Create Haven's startup page: one full-canvas, blank, event-capturing text container.
 * Must run exactly once, before any other glasses UI call and before glasses-mic capture.
 */
export async function createBlankHud(
  bridge: HavenBridge,
  timeoutMs = START_UP_TIMEOUT_MS,
): Promise<void> {
  let result: number;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The host never answers while the glasses are disconnected; without a timeout the phone
  // screen would stay blank.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BridgeUnavailableError(
            `G2 did not respond within ${timeoutMs / 1000} s. Check that the glasses are connected in the Even Realities app, then close and reopen Haven.`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    result = await Promise.race([bridge.createStartUpPageContainer(blankHudPage()), timeout]);
  } catch (error) {
    if (error instanceof BridgeUnavailableError) throw error;
    throw new BridgeUnavailableError(
      `createStartUpPageContainer failed (is this running inside the Even Realities app?): ${String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (result !== 0) {
    throw new BridgeUnavailableError(
      `createStartUpPageContainer returned ${result} (${START_UP_RESULT_NAMES[result] ?? "unknown"})`,
    );
  }
}
