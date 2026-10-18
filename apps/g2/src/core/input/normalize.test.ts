import { describe, expect, it } from "vitest";
import { OS_EVENT_TYPE } from "./event-types";
import { normalizeHubEvent, type InputSignal, type RawHubEvent } from "./normalize";

const opts = { captureContainerId: 1 };
const one = (event: RawHubEvent): InputSignal => {
  const signals = normalizeHubEvent(event, opts);
  expect(signals).toHaveLength(1);
  return signals[0]!;
};

describe("normalizeHubEvent", () => {
  it("treats a sysEvent with omitted eventType as a press (CLICK_EVENT = 0 is the protobuf default)", () => {
    expect(one({ sysEvent: { eventSource: 1 } })).toEqual({
      kind: "press_candidate",
      channel: "sys",
      source: "glasses_right",
      eventTypeOmitted: true,
    });
    expect(one({ sysEvent: {} })).toMatchObject({ kind: "press_candidate", source: "unknown" });
  });

  it("treats explicit CLICK_EVENT as a press on either envelope", () => {
    expect(one({ sysEvent: { eventType: 0, eventSource: 2 } })).toEqual({
      kind: "press_candidate",
      channel: "sys",
      source: "ring",
      eventTypeOmitted: false,
    });
    expect(one({ textEvent: { containerID: 1, eventType: 0 } })).toMatchObject({
      kind: "press_candidate",
      channel: "text",
      eventTypeOmitted: false,
    });
    expect(one({ textEvent: { containerID: 1 } })).toMatchObject({
      kind: "press_candidate",
      eventTypeOmitted: true,
    });
  });

  it("never treats a missing envelope as a press", () => {
    expect(one({})).toEqual({ kind: "ignored", reason: "no_input_envelope" });
    expect(one({ audioEvent: { audioPcm: new Uint8Array(4) } })).toEqual({
      kind: "ignored",
      reason: "audio_frame",
    });
    expect(one({ listEvent: {} })).toEqual({ kind: "ignored", reason: "list_event" });
    expect(one({ menuItemClickEvent: { itemID: 1 } })).toEqual({
      kind: "ignored",
      reason: "menu_item",
    });
  });

  it("recognises double presses before any single-press interpretation", () => {
    expect(one({ sysEvent: { eventType: OS_EVENT_TYPE.DOUBLE_CLICK, eventSource: 3 } })).toEqual({
      kind: "double_press",
      channel: "sys",
      source: "glasses_left",
    });
    expect(one({ textEvent: { containerID: 1, eventType: 3 } })).toMatchObject({
      kind: "double_press",
      channel: "text",
    });
  });

  it("maps lifecycle events and never treats them as presses", () => {
    const cases: [number, string][] = [
      [OS_EVENT_TYPE.FOREGROUND_ENTER, "foreground_enter"],
      [OS_EVENT_TYPE.FOREGROUND_EXIT, "foreground_exit"],
      [OS_EVENT_TYPE.ABNORMAL_EXIT, "abnormal_exit"],
      [OS_EVENT_TYPE.SYSTEM_EXIT, "system_exit"],
    ];
    for (const [eventType, lifecycle] of cases) {
      expect(one({ sysEvent: { eventType } })).toEqual({
        kind: "lifecycle",
        channel: "sys",
        lifecycle,
      });
      expect(one({ textEvent: { containerID: 1, eventType } })).toMatchObject({ lifecycle });
    }
  });

  it("never treats IMU samples as presses, even with eventType omitted", () => {
    expect(one({ sysEvent: { eventType: 8, imuData: { x: 1, y: 2, z: 3 } } })).toEqual({
      kind: "ignored",
      reason: "imu_sample",
    });
    expect(one({ sysEvent: { imuData: { x: 0, y: 0, z: 0 } } })).toEqual({
      kind: "ignored",
      reason: "imu_sample",
    });
    expect(one({ sysEvent: { eventType: 8 } })).toEqual({ kind: "ignored", reason: "imu_sample" });
  });

  it("ignores long press, scroll, exit details, unknown types, and other containers", () => {
    expect(one({ sysEvent: { eventType: 9 } })).toEqual({ kind: "ignored", reason: "long_press" });
    expect(one({ sysEvent: { eventType: 10 } })).toEqual({ kind: "ignored", reason: "long_press" });
    expect(one({ textEvent: { containerID: 1, eventType: 1 } })).toEqual({
      kind: "ignored",
      reason: "scroll",
    });
    expect(one({ sysEvent: { systemExitReasonCode: 2 } })).toEqual({
      kind: "ignored",
      reason: "system_exit_detail",
    });
    expect(one({ sysEvent: { eventType: 42 } })).toEqual({
      kind: "ignored",
      reason: "unknown_event_type",
    });
    expect(one({ sysEvent: { eventType: "CLICK_EVENT" } })).toEqual({
      kind: "ignored",
      reason: "unknown_event_type",
    });
    expect(one({ textEvent: { containerID: 2 } })).toEqual({
      kind: "ignored",
      reason: "other_container",
    });
  });

  it("returns one candidate per envelope when a press is reported on both", () => {
    const signals = normalizeHubEvent(
      { textEvent: { containerID: 1 }, sysEvent: { eventSource: 1 } },
      opts,
    );
    expect(signals.map((s) => s.kind)).toEqual(["press_candidate", "press_candidate"]);
  });
});
