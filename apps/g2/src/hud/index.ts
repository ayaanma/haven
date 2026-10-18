import {
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { HUD_COPY, type HavenClientState } from "@haven/contracts";
import { BLANK_HUD_CONTENT, G2_CANVAS, HUD_CONTAINER } from "../core/bootstrap";
import type { HavenBridge } from "../core/bridge";

export interface HudModel {
  state: HavenClientState;
  countdownSeconds?: number;
  acceptedCount?: number;
  totalRecipients?: number;
  deliveredCount?: number;
  recordingElapsedMs?: number;
  uploadStatus?: string;
  replies?: readonly string[];
  error?: string;
}

export interface HudRenderer {
  showBlank(): Promise<void>;
  render(model: HudModel): Promise<void>;
  content(model: HudModel): string;
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function hudContent(model: HudModel): string {
  const replies = model.replies?.slice(-3) ?? [];
  switch (model.state) {
    case "IDLE":
      return BLANK_HUD_CONTENT;
    case "COUNTDOWN":
      return [
        HUD_COPY.countdownQuestion,
        HUD_COPY.countdownCancelHint,
        HUD_COPY.countdownSending,
        "",
        String(model.countdownSeconds ?? 5),
      ].join("\n");
    case "SUBMITTING_SOS":
      return "Sending SOS...";
    case "WAITING_FOR_PHOTON":
      return ["Contacting emergency contacts...", ...replies].join("\n");
    case "RECORDING": {
      const accepted = model.acceptedCount ?? 0;
      const total = model.totalRecipients ?? accepted;
      const provider = `Accepted by Photon ${accepted}/${total}`;
      const delivered = model.deliveredCount ? `Delivered ${model.deliveredCount}/${total}` : null;
      return [
        HUD_COPY.sosSent,
        provider,
        delivered,
        `${HUD_COPY.recording} ${formatDuration(model.recordingElapsedMs ?? 0)}`,
        HUD_COPY.recordingHint,
        ...replies,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    }
    case "UPLOADING_AUDIO":
      return ["Sending recording...", model.uploadStatus, ...replies].filter(Boolean).join("\n");
    case "ACTIVE_ALERT":
      return [model.uploadStatus ?? "Alert active", ...replies].filter(Boolean).join("\n");
    case "ERROR":
      return [model.error ?? "Haven encountered an error.", ...replies].filter(Boolean).join("\n");
  }
}

export function createHudRenderer(
  bridge: Pick<HavenBridge, "textContainerUpgrade" | "rebuildPageContainer">,
): HudRenderer {
  // bootstrap.ts has already created this exact blank content. Avoid a redundant upgrade while
  // the host is still registering the startup container (simulator and hardware race otherwise).
  let lastContent: string | null = BLANK_HUD_CONTENT;
  let desiredContent: string | null = null;
  let drain: Promise<void> | null = null;

  const update = (content: string): Promise<void> => {
    desiredContent = content;
    if (content === lastContent && !drain) return Promise.resolve();
    if (!drain) {
      drain = (async () => {
        while (desiredContent !== null && desiredContent !== lastContent) {
          const next = desiredContent;
          const updated = await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: HUD_CONTAINER.id,
              containerName: HUD_CONTAINER.name,
              content: next,
              contentOffset: 0,
              contentLength: 0,
              textColor: 4,
            }),
          );
          if (!updated) {
            const rebuilt = await bridge.rebuildPageContainer(
              new RebuildPageContainer({
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
                    content: next,
                    isEventCapture: 1,
                    textColor: 4,
                  }),
                ],
              }),
            );
            if (!rebuilt) throw new Error("Haven HUD update was rejected by the Even App");
          }
          lastContent = next;
        }
      })().finally(() => {
        drain = null;
      });
    }
    return drain;
  };

  return {
    showBlank: () => update(BLANK_HUD_CONTENT),
    render: (model) => update(hudContent(model)),
    content: hudContent,
  };
}
