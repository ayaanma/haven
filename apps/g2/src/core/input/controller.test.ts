import { beforeEach, describe, expect, it } from "vitest";
import { SOS_COUNTDOWN_MS, isCancelPressInTime, singlePressAction } from "@haven/contracts";
import { FakeBridge, ManualScheduler } from "../../testing";
import type { HavenInputEvent } from "../interfaces";
import { createSdkInputController, type SdkInputController } from "./controller";
import { DEFAULT_CLICK_DISAMBIGUATION_MS as WINDOW } from "./disambiguator";

// Host messages go through the real SDK parser (FakeBridge.emitHostMessage →
// evenHubEventFromJson), so these tests exercise the SDK's actual parsing behavior.
const sysClick = (eventSource = 1) => ({ type: "sysEvent", jsonData: { eventSource } });
const textClick = { type: "textEvent", jsonData: { containerID: 1, containerName: "haven-hud" } };
const sysDouble = { type: "sysEvent", jsonData: { eventType: 3, eventSource: 1 } };

let bridge: FakeBridge;
let scheduler: ManualScheduler;
let controller: SdkInputController;
let events: HavenInputEvent[];

beforeEach(() => {
  bridge = new FakeBridge();
  scheduler = new ManualScheduler(50_000);
  controller = createSdkInputController(bridge, { scheduler });
  events = [];
  controller.subscribe((e) => events.push(e));
});

const kinds = () => events.map((e) => e.kind);

describe("SdkInputController (real SDK parsing)", () => {
  it("delivers one single press for an omitted-eventType sysEvent", () => {
    const parsed = bridge.emitHostMessage(sysClick());
    expect(parsed.sysEvent?.eventType).toBeUndefined(); // the SDK really passes undefined through
    scheduler.advance(WINDOW);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "single_press",
        pressedAtMs: 50_000,
        source: "glasses_right",
        eventTypeOmitted: true,
      }),
    ]);
  });

  it("delivers one single press for a text-container click", () => {
    bridge.emitHostMessage(textClick);
    scheduler.advance(WINDOW);
    expect(kinds()).toEqual(["single_press"]);
  });

  it("coalesces a press reported on both textEvent and sysEvent", () => {
    bridge.emitHostMessage(textClick);
    bridge.emitHostMessage(sysClick());
    scheduler.advance(WINDOW);
    expect(kinds()).toEqual(["single_press"]);
    expect(controller.diagnostics().disambiguation.coalesced).toBe(1);
  });

  it("double press opens the system exit dialog and never yields a single press", () => {
    bridge.emitHostMessage(sysClick());
    scheduler.advance(150);
    bridge.emitHostMessage(sysDouble);
    scheduler.advance(2_000);
    expect(kinds()).toEqual(["double_press"]);
    expect(bridge.shutdowns).toEqual([1]);
  });

  it("ignores IMU samples, audio frames, and empty messages", () => {
    bridge.emitHostMessage({
      type: "sysEvent",
      jsonData: { eventType: 8, imuData: { x: 1, y: 2, z: 3 } },
    });
    bridge.emitHostMessage({
      type: "audioEvent",
      jsonData: { audioPcm: [0, 0], source: "glasses" },
    });
    bridge.emitHostMessage({ type: "bogus", jsonData: {} });
    bridge.emitHostMessage(null);
    scheduler.advance(2_000);
    expect(events).toEqual([]);
    expect(controller.diagnostics().ignored).toMatchObject({
      imu_sample: 1,
      audio_frame: 1,
      no_input_envelope: 2,
    });
  });

  it("reports lifecycle events and drops a held press when the app leaves the foreground", () => {
    bridge.emitHostMessage(sysClick());
    bridge.emitHostMessage({ type: "sysEvent", jsonData: { eventType: 5 } });
    scheduler.advance(2_000);
    expect(events).toEqual([
      expect.objectContaining({ kind: "lifecycle", lifecycle: "foreground_exit" }),
    ]);
  });

  it("drops presses that arrive before anyone subscribes, and after unsubscribe", () => {
    controller.unsubscribe();
    bridge.emitHostMessage(sysClick());
    scheduler.advance(WINDOW);
    expect(events).toEqual([]);
  });

  it("dispose detaches from the bridge", () => {
    controller.dispose();
    expect(bridge.listenerCount()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  it("a cancel press just before the countdown deadline still cancels", () => {
    // Activation press.
    bridge.emitHostMessage(sysClick());
    scheduler.advance(WINDOW);
    const activation = events[0]!;
    expect(activation.kind === "single_press" && singlePressAction("IDLE")).toBe("start_countdown");
    const deadline =
      (activation.kind === "single_press" ? activation.pressedAtMs : 0) + SOS_COUNTDOWN_MS;

    // Cancel press 50 ms before the deadline resolves after it...
    scheduler.advance(deadline - scheduler.now() - 50);
    bridge.emitHostMessage(sysClick());
    scheduler.advance(WINDOW);
    const cancel = events[1]!;
    expect(cancel.kind).toBe("single_press");
    if (cancel.kind !== "single_press") return;
    expect(cancel.resolvedAtMs).toBeGreaterThan(deadline);
    // ...but is judged by when it was pressed.
    expect(isCancelPressInTime(cancel.pressedAtMs, deadline)).toBe(true);
  });

  it("can opt out of the automatic exit dialog (tests only)", () => {
    controller.dispose();
    controller = createSdkInputController(bridge, { scheduler, exitOnDoublePress: false });
    controller.subscribe((e) => events.push(e));
    bridge.emitHostMessage(sysDouble);
    expect(bridge.shutdowns).toEqual([]);
    expect(kinds()).toEqual(["double_press"]);
  });
});
