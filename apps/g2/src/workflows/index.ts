import {
  AlertIdSchema,
  ClientAlertIdSchema,
  EventCursorSchema,
  SOS_COUNTDOWN_MS,
  countdownSecondsRemaining,
  isCancelPressInTime,
  singlePressAction,
  type AlertEvent,
  type HavenClientState,
  type SOSRequest,
} from "@haven/contracts";
import type { HavenAppContext } from "../core/app-context";
import type { HavenInputEvent } from "../core/interfaces";
import type { TimerHandle } from "../core/scheduler";
import { createHudRenderer, type HudModel, type HudRenderer } from "../hud";

export const ALERT_POLL_INTERVAL_MS = 1_500;
export const ALERT_POLL_MAX_BACKOFF_MS = 30_000;
const WORKFLOW_STORAGE_KEY = "haven.workflow.v1";
const RESET_EVENT = "haven:reset";

interface PersistedWorkflow {
  state: HavenClientState;
  alertId: string;
  clientAlertId: string;
  cursor: string | null;
  acceptedCount: number;
  totalRecipients: number;
}

export interface HavenWorkflow {
  readonly state: HavenClientState;
  readonly ready: Promise<void>;
  reset(): Promise<void>;
  stop(): void;
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unexpected error";
}

function parsePersisted(raw: string): PersistedWorkflow | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedWorkflow>;
    if (
      !value ||
      typeof value !== "object" ||
      !AlertIdSchema.safeParse(value.alertId).success ||
      !ClientAlertIdSchema.safeParse(value.clientAlertId).success ||
      (value.cursor !== null && !EventCursorSchema.safeParse(value.cursor).success) ||
      typeof value.acceptedCount !== "number" ||
      typeof value.totalRecipients !== "number"
    ) {
      return null;
    }
    const resumableStates: HavenClientState[] = [
      "WAITING_FOR_PHOTON",
      "RECORDING",
      "UPLOADING_AUDIO",
      "ACTIVE_ALERT",
      "ERROR",
    ];
    if (!value.state || !resumableStates.includes(value.state)) return null;
    return value as PersistedWorkflow;
  } catch {
    return null;
  }
}

export function createHavenWorkflow(
  ctx: HavenAppContext,
  options: { hud?: HudRenderer } = {},
): HavenWorkflow {
  const hud = options.hud ?? createHudRenderer(ctx.bridge);
  let currentState: HavenClientState = "IDLE";
  let stopped = false;
  let generation = 0;
  let activationPressedAtMs: number | null = null;
  let countdownDeadlineMs: number | null = null;
  let countdownTick: TimerHandle | null = null;
  let countdownSubmit: TimerHandle | null = null;
  let pollTimer: TimerHandle | null = null;
  let polling = false;
  let pollFailures = 0;
  let alertId: string | null = null;
  let clientAlertId: string | null = null;
  let cursor: string | null = null;
  let acceptedCount = 0;
  let totalRecipients = 0;
  let deliveredCount = 0;
  let recordingElapsedMs = 0;
  let recordingStartRequested = false;
  let uploadStatus: string | undefined;
  let errorMessage: string | undefined;
  const replies: string[] = [];
  const seenEventIds = new Set<number>();

  const model = (): HudModel => ({
    state: currentState,
    ...(countdownDeadlineMs === null
      ? {}
      : {
          countdownSeconds: Math.max(
            1,
            countdownSecondsRemaining(ctx.scheduler.now(), countdownDeadlineMs),
          ),
        }),
    acceptedCount,
    totalRecipients,
    deliveredCount,
    recordingElapsedMs,
    ...(uploadStatus ? { uploadStatus } : {}),
    replies,
    ...(errorMessage ? { error: errorMessage } : {}),
  });

  const render = () => {
    void hud.render(model()).catch((error) => ctx.log.error("HUD update failed", String(error)));
  };

  const clearTimer = (handle: TimerHandle | null) => {
    if (handle !== null) ctx.scheduler.clearTimeout(handle);
  };

  const clearCountdownTimers = () => {
    clearTimer(countdownTick);
    clearTimer(countdownSubmit);
    countdownTick = null;
    countdownSubmit = null;
  };

  const clearPollTimer = () => {
    clearTimer(pollTimer);
    pollTimer = null;
  };

  const persist = () => {
    if (!alertId || !clientAlertId) return;
    const value: PersistedWorkflow = {
      state: currentState,
      alertId,
      clientAlertId,
      cursor,
      acceptedCount,
      totalRecipients,
    };
    void ctx.bridge
      .setLocalStorage(WORKFLOW_STORAGE_KEY, JSON.stringify(value))
      .catch((error: unknown) => ctx.log.error("workflow persistence failed", String(error)));
  };

  const transition = (next: HavenClientState) => {
    if (stopped || currentState === next) return;
    currentState = next;
    generation++;
    render();
    persist();
  };

  const fail = (message: string) => {
    errorMessage = message;
    clearCountdownTimers();
    clearPollTimer();
    transition("ERROR");
  };

  const schedulePoll = (delayMs: number) => {
    if (stopped || !alertId || currentState === "ERROR") return;
    clearPollTimer();
    pollTimer = ctx.scheduler.setTimeout(() => {
      pollTimer = null;
      void pollEvents();
    }, delayMs);
  };

  const startRecording = async () => {
    if (stopped || !alertId || recordingStartRequested || currentState !== "WAITING_FOR_PHOTON") {
      return;
    }
    recordingStartRequested = true;
    const expectedGeneration = generation;
    const result = await ctx.audio.startRecording(alertId).catch((error: unknown) => ({
      ok: false as const,
      reason: "bridge_error" as const,
      detail: readableError(error),
    }));
    if (stopped || generation !== expectedGeneration || currentState !== "WAITING_FOR_PHOTON")
      return;
    if (!result.ok) {
      fail(
        result.reason === "microphone_unavailable"
          ? "SOS was accepted, but the microphone is unavailable."
          : "SOS was accepted, but recording could not start.",
      );
      return;
    }
    recordingElapsedMs = Math.max(0, ctx.scheduler.now() - result.startedAtMs);
    transition("RECORDING");
  };

  const processEvent = (event: AlertEvent) => {
    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);
    switch (event.type) {
      case "alert.initial_notification_accepted":
        acceptedCount = Math.max(acceptedCount, event.payload.acceptedCount);
        totalRecipients = Math.max(totalRecipients, event.payload.totalRecipients);
        render();
        void startRecording();
        break;
      case "alert.initial_notification_failed":
        if (currentState === "WAITING_FOR_PHOTON") {
          const message =
            event.payload.reason === "no_eligible_contacts"
              ? "No eligible emergency contacts. No message was sent."
              : "No emergency message could be sent.";
          fail(message);
        }
        break;
      case "notification.delivered":
        if (event.payload.kind === "initial_sos") {
          deliveredCount++;
          render();
        }
        break;
      case "contact.responded":
        replies.push(`${event.payload.displayName}: ${event.payload.text}`);
        render();
        break;
      case "recording.notification_accepted":
        uploadStatus = "Recording sent";
        if (currentState === "UPLOADING_AUDIO") transition("ACTIVE_ALERT");
        else render();
        break;
      case "recording.failed":
        uploadStatus = "Recording failed to send. Retry from the phone.\nAlert remains active.";
        if (currentState === "UPLOADING_AUDIO") transition("ACTIVE_ALERT");
        else render();
        break;
      default:
        break;
    }
  };

  const pollEvents = async (): Promise<void> => {
    if (stopped || polling || !alertId || currentState === "ERROR") return;
    polling = true;
    try {
      let hasMore = true;
      while (hasMore && !stopped && alertId) {
        const page = await ctx.api.getAlertEvents(alertId, cursor);
        for (const event of page.events) processEvent(event);
        cursor = page.nextCursor;
        hasMore = page.hasMore;
        persist();
      }
      pollFailures = 0;
      schedulePoll(ALERT_POLL_INTERVAL_MS);
    } catch (error) {
      pollFailures++;
      const delay = Math.min(
        ALERT_POLL_INTERVAL_MS * 2 ** (pollFailures - 1),
        ALERT_POLL_MAX_BACKOFF_MS,
      );
      ctx.log.error("alert event poll failed", readableError(error));
      schedulePoll(delay);
    } finally {
      polling = false;
    }
  };

  const submitSos = async () => {
    if (
      stopped ||
      currentState !== "COUNTDOWN" ||
      activationPressedAtMs === null ||
      countdownDeadlineMs === null
    ) {
      return;
    }
    clearCountdownTimers();
    clientAlertId ??= crypto.randomUUID();
    const requestClientAlertId = clientAlertId;
    const activatedAt = activationPressedAtMs;
    transition("SUBMITTING_SOS");
    const expectedGeneration = generation;
    try {
      const snapshot = await ctx.devices.getEmergencySnapshot();
      if (stopped || generation !== expectedGeneration) return;
      const request: SOSRequest = {
        clientAlertId: requestClientAlertId,
        activatedAt,
        ...(snapshot.location ? { location: snapshot.location } : {}),
        ...(snapshot.motionSummary ? { motionSummary: snapshot.motionSummary } : {}),
      };
      const response = await ctx.api.createAlert(request);
      if (stopped || generation !== expectedGeneration) return;
      alertId = response.alert.alertId;
      totalRecipients = response.alert.totalRecipients;
      transition("WAITING_FOR_PHOTON");
      void pollEvents();
    } catch (error) {
      if (stopped || generation !== expectedGeneration) return;
      fail(
        `SOS could not reach the Haven server. No success was confirmed. ${readableError(error)}`,
      );
    }
  };

  const scheduleCountdown = () => {
    if (countdownDeadlineMs === null || currentState !== "COUNTDOWN") return;
    render();
    const remaining = countdownSecondsRemaining(ctx.scheduler.now(), countdownDeadlineMs);
    if (remaining > 1) {
      const nextBoundary = countdownDeadlineMs - (remaining - 1) * 1_000;
      countdownTick = ctx.scheduler.setTimeout(
        scheduleCountdown,
        Math.max(0, nextBoundary - ctx.scheduler.now()),
      );
    }
  };

  const beginCountdown = (event: Extract<HavenInputEvent, { kind: "single_press" }>) => {
    activationPressedAtMs = event.pressedAtMs;
    countdownDeadlineMs = event.pressedAtMs + SOS_COUNTDOWN_MS;
    clientAlertId = null;
    errorMessage = undefined;
    transition("COUNTDOWN");
    scheduleCountdown();
    const submitAt = countdownDeadlineMs + ctx.config.clickDisambiguationMs;
    countdownSubmit = ctx.scheduler.setTimeout(
      () => void submitSos(),
      Math.max(0, submitAt - ctx.scheduler.now()),
    );
  };

  const cancelCountdown = (event: Extract<HavenInputEvent, { kind: "single_press" }>) => {
    if (
      countdownDeadlineMs === null ||
      !isCancelPressInTime(event.pressedAtMs, countdownDeadlineMs)
    ) {
      return;
    }
    clearCountdownTimers();
    activationPressedAtMs = null;
    countdownDeadlineMs = null;
    clientAlertId = null;
    transition("IDLE");
  };

  const stopAndSendRecording = async () => {
    if (stopped || currentState !== "RECORDING" || !alertId) return;
    const activeAlertId = alertId;
    uploadStatus = undefined;
    transition("UPLOADING_AUDIO");
    const expectedGeneration = generation;
    const result = await ctx.audio.stopAndSendRecording(activeAlertId).catch((error: unknown) => ({
      ok: false as const,
      reason: "upload_failed" as const,
      retryable: true,
      detail: readableError(error),
    }));
    if (stopped || generation !== expectedGeneration) return;
    if (result.ok) {
      uploadStatus = "Recording sent";
    } else {
      uploadStatus = result.retryable
        ? "Recording failed to send. Retry from the phone.\nAlert remains active."
        : "Recording could not be sent.\nAlert remains active.";
    }
    transition("ACTIVE_ALERT");
  };

  const onInput = (event: HavenInputEvent) => {
    if (stopped) return;
    ctx.log.info(`input ${event.kind}`);
    if (event.kind === "double_press") return;
    if (event.kind === "lifecycle") {
      if (event.lifecycle === "foreground_enter") {
        void ctx.devices.startSensorCollection();
        if (alertId) void pollEvents();
      } else {
        clearPollTimer();
      }
      return;
    }
    switch (singlePressAction(currentState)) {
      case "start_countdown":
        beginCountdown(event);
        break;
      case "cancel_countdown":
        cancelCountdown(event);
        break;
      case "stop_and_send_recording":
        void stopAndSendRecording();
        break;
      case "ignore":
      case "ignore_until_reset":
        break;
    }
  };

  const unsubscribeProgress = ctx.audio.onProgress((progress) => {
    if (stopped) return;
    recordingElapsedMs = progress.elapsedMs;
    if (currentState === "UPLOADING_AUDIO") {
      if (progress.phase === "uploading") {
        uploadStatus = `${progress.uploadedChunks} uploaded, ${progress.pendingChunks} remaining`;
      } else if (progress.phase === "notifying") {
        uploadStatus = "Recording uploaded. Contacting emergency contacts...";
      }
    }
    if (currentState === "RECORDING" || currentState === "UPLOADING_AUDIO") render();
  });

  const reset = async () => {
    if (currentState !== "ERROR") return;
    generation++;
    clearCountdownTimers();
    clearPollTimer();
    await ctx.audio.disposeRecording();
    alertId = null;
    clientAlertId = null;
    cursor = null;
    acceptedCount = 0;
    totalRecipients = 0;
    deliveredCount = 0;
    recordingElapsedMs = 0;
    recordingStartRequested = false;
    uploadStatus = undefined;
    errorMessage = undefined;
    replies.length = 0;
    seenEventIds.clear();
    currentState = "IDLE";
    await ctx.bridge.setLocalStorage(WORKFLOW_STORAGE_KEY, "");
    render();
  };

  const onReset = () => void reset();
  if (typeof window !== "undefined") window.addEventListener(RESET_EVENT, onReset);
  ctx.input.subscribe(onInput);
  render();

  const restoreGeneration = generation;
  const ready = ctx.bridge
    .getLocalStorage(WORKFLOW_STORAGE_KEY)
    .then(async (raw) => {
      const saved = parsePersisted(raw);
      if (!saved || stopped || generation !== restoreGeneration || currentState !== "IDLE") return;
      alertId = saved.alertId;
      clientAlertId = saved.clientAlertId;
      cursor = saved.cursor;
      acceptedCount = saved.acceptedCount;
      totalRecipients = saved.totalRecipients;
      currentState = saved.state === "UPLOADING_AUDIO" ? "ACTIVE_ALERT" : saved.state;
      if (saved.state === "UPLOADING_AUDIO") {
        uploadStatus =
          "Recording upload was interrupted. Retry from the phone.\nAlert remains active.";
      }
      render();
      try {
        const record = await ctx.api.getAlert(saved.alertId);
        if (stopped || alertId !== saved.alertId) return;
        acceptedCount = Math.max(acceptedCount, record.initialAcceptedCount);
        totalRecipients = Math.max(totalRecipients, record.totalRecipients);
        deliveredCount = Math.max(deliveredCount, record.initialDeliveredCount);
        if (record.state === "notification_failed") {
          fail("No emergency message could be sent.");
          return;
        }
        if (record.recording.status === "completed") {
          currentState = "ACTIVE_ALERT";
          uploadStatus = record.recording.notificationAcceptedCount
            ? "Recording sent"
            : "Recording uploaded. Contact notification is not yet confirmed.";
          render();
          persist();
        } else if (record.initialAcceptedCount > 0 && saved.state !== "ACTIVE_ALERT") {
          currentState = "WAITING_FOR_PHOTON";
          render();
          void startRecording();
        }
      } catch (error) {
        ctx.log.error("active alert recovery failed", readableError(error));
      }
      void pollEvents();
    })
    .catch((error: unknown) => ctx.log.error("workflow restore failed", String(error)));

  return {
    get state() {
      return currentState;
    },
    ready,
    reset,
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      clearCountdownTimers();
      clearPollTimer();
      ctx.input.unsubscribe();
      unsubscribeProgress();
      if (typeof window !== "undefined") window.removeEventListener(RESET_EVENT, onReset);
    },
  };
}

/** Starts the workflow; returns a function that stops it. */
export function startHavenWorkflow(ctx: HavenAppContext): () => void {
  const workflow = createHavenWorkflow(ctx);
  return () => workflow.stop();
}
