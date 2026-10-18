/**
 * The G2 interaction contract. Haven has exactly one activation gesture: a NORMAL
 * SINGLE PRESS on the glasses (or R1 ring). Long press is not used. Double press is
 * reserved by the platform for the system exit dialog and never cancels or triggers
 * anything in Haven.
 */

export const HAVEN_CLIENT_STATES = [
  "IDLE",
  "COUNTDOWN",
  "SUBMITTING_SOS",
  "WAITING_FOR_PHOTON",
  "RECORDING",
  "UPLOADING_AUDIO",
  "ACTIVE_ALERT",
  "ERROR",
] as const;
export type HavenClientState = (typeof HAVEN_CLIENT_STATES)[number];

export type SinglePressAction =
  | "start_countdown"
  | "cancel_countdown"
  | "stop_and_send_recording"
  | "ignore"
  /** ERROR: never start a new alert from a press; only an explicit reset leaves ERROR. */
  | "ignore_until_reset";

/** What one single press does in each state. Workflows must route presses through this table. */
export const SINGLE_PRESS_BEHAVIOR: Readonly<Record<HavenClientState, SinglePressAction>> = {
  IDLE: "start_countdown",
  COUNTDOWN: "cancel_countdown",
  SUBMITTING_SOS: "ignore",
  WAITING_FOR_PHOTON: "ignore",
  RECORDING: "stop_and_send_recording",
  UPLOADING_AUDIO: "ignore",
  ACTIVE_ALERT: "ignore",
  ERROR: "ignore_until_reset",
};

export function singlePressAction(state: HavenClientState): SinglePressAction {
  return SINGLE_PRESS_BEHAVIOR[state];
}

/** The countdown between the activation press and the SOS request. */
export const SOS_COUNTDOWN_MS = 5_000;

/**
 * A cancel press counts if the wearer pressed BEFORE the deadline, even when input
 * disambiguation resolves it slightly after. Compare raw press time, not resolution time.
 * Workflows therefore submit the SOS at `deadline + clickDisambiguationMs`, not at `deadline`.
 */
export function isCancelPressInTime(pressedAtMs: number, countdownDeadlineMs: number): boolean {
  return pressedAtMs < countdownDeadlineMs;
}

/** Whole seconds to show on the countdown (5, 4, 3, 2, 1), never below 0. */
export function countdownSecondsRemaining(nowMs: number, countdownDeadlineMs: number): number {
  return Math.max(0, Math.ceil((countdownDeadlineMs - nowMs) / 1000));
}

/** Exact HUD copy required by the product spec. Do not paraphrase. */
export const HUD_COPY = {
  countdownQuestion: "Are you in danger?",
  countdownCancelHint: "If not, click to disable.",
  countdownSending: "Sending message in...",
  sosSent: "SOS sent",
  recording: "Recording...",
  recordingHint: "Click to send audio",
} as const;
