// Owner: Agent 1. Placeholder created by the foundation commit.
//
// Render the countdown, "SOS sent", recording timer, upload status, and contact replies.
// Use HUD_COPY from @haven/contracts verbatim. Prefer textContainerUpgrade on HUD_CONTAINER
// (flicker-free); rebuildPageContainer only for layout changes, keeping exactly one
// isEventCapture container. Only show statuses and replies that come from AlertEvents.
import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { BLANK_HUD_CONTENT, HUD_CONTAINER } from "../core/bootstrap";
import type { HavenBridge } from "../core/bridge";

export interface HudRenderer {
  showBlank(): Promise<void>;
}

export function createHudRenderer(bridge: Pick<HavenBridge, "textContainerUpgrade">): HudRenderer {
  return {
    async showBlank() {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: HUD_CONTAINER.id,
          containerName: HUD_CONTAINER.name,
          content: BLANK_HUD_CONTENT,
        }),
      );
    },
  };
}
