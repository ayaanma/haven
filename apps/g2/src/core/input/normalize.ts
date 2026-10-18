import {
  LIFECYCLE_BY_EVENT_TYPE,
  OS_EVENT_TYPE,
  inputSourceFrom,
  type InputSource,
  type LifecycleKind,
} from "./event-types";

/**
 * Structural subset of the SDK's parsed `EvenHubEvent` (from `bridge.onEvenHubEvent`).
 * Kept structural so normalization is testable without the bridge.
 */
export interface RawHubEvent {
  textEvent?: { containerID?: number; containerName?: string; eventType?: unknown } | undefined;
  sysEvent?:
    | {
        eventType?: unknown;
        eventSource?: unknown;
        imuData?: unknown;
        systemExitReasonCode?: unknown;
      }
    | undefined;
  listEvent?: unknown;
  audioEvent?: unknown;
  menuItemClickEvent?: unknown;
}

export type InputChannel = "text" | "sys";

export type IgnoreReason =
  | "no_input_envelope"
  | "imu_sample"
  | "audio_frame"
  | "list_event"
  | "menu_item"
  | "other_container"
  | "scroll"
  | "long_press"
  | "system_exit_detail"
  | "unknown_event_type";

export type InputSignal =
  | {
      kind: "press_candidate";
      channel: InputChannel;
      source: InputSource;
      eventTypeOmitted: boolean;
    }
  | { kind: "double_press"; channel: InputChannel; source: InputSource }
  | { kind: "lifecycle"; channel: InputChannel; lifecycle: LifecycleKind }
  | { kind: "ignored"; reason: IgnoreReason };

/**
 * Classify one SDK event. Order matters and follows the Haven interaction contract:
 *
 * 1. No text/sys envelope at all (audio, list, menu, empty object) is never a press.
 * 2. IMU samples are never presses, even if their eventType were omitted.
 * 3. Explicit DOUBLE_CLICK (3) and lifecycle events (4–7) are handled BEFORE any
 *    single-press interpretation.
 * 4. Long press (9/10) and scroll (1/2) are ignored: Haven uses only a single press.
 * 5. Only then is CLICK_EVENT recognised, either explicitly (0) or as an omitted eventType:
 *    CLICK_EVENT is the protobuf default, so the host often drops the field and the SDK
 *    passes `undefined` through (verified against SDK 0.0.16 `evenHubEventFromJson`).
 *
 * Returns one signal per envelope present (usually one). A press reported on both
 * envelopes yields two candidates; the disambiguator coalesces them into one press.
 */
export function normalizeHubEvent(
  event: RawHubEvent,
  options: { captureContainerId: number },
): InputSignal[] {
  const signals: InputSignal[] = [];
  if (event.textEvent) signals.push(classifyText(event.textEvent, options.captureContainerId));
  if (event.sysEvent) signals.push(classifySys(event.sysEvent));
  if (signals.length > 0) return signals;

  if (event.audioEvent) return [{ kind: "ignored", reason: "audio_frame" }];
  if (event.listEvent) return [{ kind: "ignored", reason: "list_event" }];
  if (event.menuItemClickEvent) return [{ kind: "ignored", reason: "menu_item" }];
  return [{ kind: "ignored", reason: "no_input_envelope" }];
}

function classifyCommon(
  eventType: unknown,
  channel: InputChannel,
  source: InputSource,
): InputSignal | null {
  if (eventType === OS_EVENT_TYPE.DOUBLE_CLICK) return { kind: "double_press", channel, source };
  if (typeof eventType === "number" && eventType in LIFECYCLE_BY_EVENT_TYPE) {
    return { kind: "lifecycle", channel, lifecycle: LIFECYCLE_BY_EVENT_TYPE[eventType]! };
  }
  if (eventType === OS_EVENT_TYPE.LONG_PRESS || eventType === OS_EVENT_TYPE.LONG_PRESS_RELEASE) {
    return { kind: "ignored", reason: "long_press" };
  }
  if (eventType === OS_EVENT_TYPE.SCROLL_TOP || eventType === OS_EVENT_TYPE.SCROLL_BOTTOM) {
    return { kind: "ignored", reason: "scroll" };
  }
  if (eventType === OS_EVENT_TYPE.IMU_DATA_REPORT) return { kind: "ignored", reason: "imu_sample" };
  return null;
}

function classifyText(
  text: NonNullable<RawHubEvent["textEvent"]>,
  captureContainerId: number,
): InputSignal {
  if (text.containerID !== undefined && text.containerID !== captureContainerId) {
    return { kind: "ignored", reason: "other_container" };
  }
  const source: InputSource = "unknown";
  const common = classifyCommon(text.eventType, "text", source);
  if (common) return common;
  if (text.eventType === OS_EVENT_TYPE.CLICK) {
    return { kind: "press_candidate", channel: "text", source, eventTypeOmitted: false };
  }
  if (text.eventType === undefined || text.eventType === null) {
    return { kind: "press_candidate", channel: "text", source, eventTypeOmitted: true };
  }
  return { kind: "ignored", reason: "unknown_event_type" };
}

function classifySys(sys: NonNullable<RawHubEvent["sysEvent"]>): InputSignal {
  if (sys.imuData !== undefined && sys.imuData !== null) {
    return { kind: "ignored", reason: "imu_sample" };
  }
  const source = inputSourceFrom(sys.eventSource);
  const common = classifyCommon(sys.eventType, "sys", source);
  if (common) return common;
  if (sys.eventType === OS_EVENT_TYPE.CLICK) {
    return { kind: "press_candidate", channel: "sys", source, eventTypeOmitted: false };
  }
  if (sys.eventType === undefined || sys.eventType === null) {
    // An exit reason without an event type is not a press.
    if (sys.systemExitReasonCode !== undefined && sys.systemExitReasonCode !== null) {
      return { kind: "ignored", reason: "system_exit_detail" };
    }
    return { kind: "press_candidate", channel: "sys", source, eventTypeOmitted: true };
  }
  return { kind: "ignored", reason: "unknown_event_type" };
}
