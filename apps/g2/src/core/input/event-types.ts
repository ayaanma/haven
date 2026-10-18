/**
 * Numeric values of the SDK's `OsEventTypeList` and `EventSourceType` enums, mirrored so
 * input normalization can be unit-tested without loading the bridge. sdk-parity.test.ts
 * fails if the installed SDK ever disagrees.
 */
export const OS_EVENT_TYPE = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  IMU_DATA_REPORT: 8,
  LONG_PRESS: 9,
  LONG_PRESS_RELEASE: 10,
} as const;

export const EVENT_SOURCE = {
  NONE: 0,
  GLASSES_RIGHT: 1,
  RING: 2,
  GLASSES_LEFT: 3,
} as const;

export type InputSource = "glasses_right" | "glasses_left" | "ring" | "unknown";

export function inputSourceFrom(eventSource: unknown): InputSource {
  switch (eventSource) {
    case EVENT_SOURCE.GLASSES_RIGHT:
      return "glasses_right";
    case EVENT_SOURCE.GLASSES_LEFT:
      return "glasses_left";
    case EVENT_SOURCE.RING:
      return "ring";
    default:
      return "unknown";
  }
}

export type LifecycleKind =
  "foreground_enter" | "foreground_exit" | "abnormal_exit" | "system_exit";

export const LIFECYCLE_BY_EVENT_TYPE: Readonly<Record<number, LifecycleKind>> = {
  [OS_EVENT_TYPE.FOREGROUND_ENTER]: "foreground_enter",
  [OS_EVENT_TYPE.FOREGROUND_EXIT]: "foreground_exit",
  [OS_EVENT_TYPE.ABNORMAL_EXIT]: "abnormal_exit",
  [OS_EVENT_TYPE.SYSTEM_EXIT]: "system_exit",
};
