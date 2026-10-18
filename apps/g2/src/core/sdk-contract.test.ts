// Verifies Haven's assumptions against the INSTALLED Even Hub SDK, not documentation.
// If an SDK upgrade breaks one of these, update core/ (foundation) before anything else.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  AudioInputSource,
  EventSourceType,
  OsEventTypeList,
  evenHubEventFromJson,
  validateEvenHubPageContainer,
} from "@evenrealities/even_hub_sdk";
import { describe, expect, it } from "vitest";
import { blankHudPage } from "./bootstrap";
import { EVENT_SOURCE, OS_EVENT_TYPE } from "./input/event-types";

// The SDK's exports map hides package.json, so locate it from the resolved entry point.
const sdkEntry = createRequire(import.meta.url).resolve("@evenrealities/even_hub_sdk");
const sdkPackage = JSON.parse(
  readFileSync(path.join(path.dirname(sdkEntry), "..", "package.json"), "utf8"),
) as { version: string; minAppVersion?: string };
const appJson = JSON.parse(readFileSync(new URL("../../app.json", import.meta.url), "utf8")) as {
  min_sdk_version: string;
};

describe("installed Even Hub SDK", () => {
  it("is the version the manifest declares", () => {
    expect(sdkPackage.version).toBe("0.0.16");
    expect(appJson.min_sdk_version).toBe(sdkPackage.version);
  });

  it("uses the event type values Haven mirrors", () => {
    expect(OsEventTypeList.CLICK_EVENT).toBe(OS_EVENT_TYPE.CLICK);
    expect(OsEventTypeList.DOUBLE_CLICK_EVENT).toBe(OS_EVENT_TYPE.DOUBLE_CLICK);
    expect(OsEventTypeList.SCROLL_TOP_EVENT).toBe(OS_EVENT_TYPE.SCROLL_TOP);
    expect(OsEventTypeList.SCROLL_BOTTOM_EVENT).toBe(OS_EVENT_TYPE.SCROLL_BOTTOM);
    expect(OsEventTypeList.FOREGROUND_ENTER_EVENT).toBe(OS_EVENT_TYPE.FOREGROUND_ENTER);
    expect(OsEventTypeList.FOREGROUND_EXIT_EVENT).toBe(OS_EVENT_TYPE.FOREGROUND_EXIT);
    expect(OsEventTypeList.ABNORMAL_EXIT_EVENT).toBe(OS_EVENT_TYPE.ABNORMAL_EXIT);
    expect(OsEventTypeList.SYSTEM_EXIT_EVENT).toBe(OS_EVENT_TYPE.SYSTEM_EXIT);
    expect(OsEventTypeList.IMU_DATA_REPORT).toBe(OS_EVENT_TYPE.IMU_DATA_REPORT);
    expect(OsEventTypeList.LONG_PRESS_EVENT).toBe(OS_EVENT_TYPE.LONG_PRESS);
    expect(OsEventTypeList.LONG_PRESS_RELEASE_EVENT).toBe(OS_EVENT_TYPE.LONG_PRESS_RELEASE);
    expect(EventSourceType.TOUCH_EVENT_FROM_GLASSES_R).toBe(EVENT_SOURCE.GLASSES_RIGHT);
    expect(EventSourceType.TOUCH_EVENT_FROM_RING).toBe(EVENT_SOURCE.RING);
    expect(EventSourceType.TOUCH_EVENT_FROM_GLASSES_L).toBe(EVENT_SOURCE.GLASSES_LEFT);
    expect(AudioInputSource.Glasses).toBe("glasses");
  });

  it("passes an omitted eventType through as undefined (protobuf default for CLICK_EVENT)", () => {
    expect(
      evenHubEventFromJson({ type: "sysEvent", jsonData: { eventSource: 1 } }).sysEvent,
    ).toEqual(expect.objectContaining({ eventSource: 1 }));
    expect(
      evenHubEventFromJson({ type: "sysEvent", jsonData: {} }).sysEvent?.eventType,
    ).toBeUndefined();
    expect(
      evenHubEventFromJson({ type: "textEvent", jsonData: { containerID: 1 } }).textEvent
        ?.eventType,
    ).toBeUndefined();
  });

  it("normalizes string event types to numbers", () => {
    expect(
      evenHubEventFromJson({ type: "sys_event", data: { Event_Type: "DOUBLE_CLICK_EVENT" } })
        .sysEvent?.eventType,
    ).toBe(3);
  });

  it("produces no envelope for unknown or empty messages", () => {
    const event = evenHubEventFromJson({ type: "unknown", jsonData: { eventType: 0 } });
    expect(event.sysEvent).toBeUndefined();
    expect(event.textEvent).toBeUndefined();
  });

  it("accepts Haven's blank startup page", () => {
    const result = validateEvenHubPageContainer(blankHudPage());
    expect(result).toEqual({ valid: true });
  });
});
