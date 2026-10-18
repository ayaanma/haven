import { beforeEach, describe, expect, it } from "vitest";
import { ManualScheduler } from "../../testing/manual-scheduler";
import {
  DEFAULT_CLICK_DISAMBIGUATION_MS as WINDOW,
  DEFAULT_POST_DOUBLE_PRESS_SUPPRESS_MS as SUPPRESS,
  PressDisambiguator,
  type ResolvedDoublePress,
  type ResolvedSinglePress,
} from "./disambiguator";

const candidate = { channel: "sys", source: "glasses_right", eventTypeOmitted: true } as const;
const double = { channel: "sys", source: "glasses_right" } as const;

let scheduler: ManualScheduler;
let singles: ResolvedSinglePress[];
let doubles: ResolvedDoublePress[];
let d: PressDisambiguator;

function make(windowMs = WINDOW) {
  d = new PressDisambiguator({
    scheduler,
    windowMs,
    onSinglePress: (p) => singles.push(p),
    onDoublePress: (p) => doubles.push(p),
  });
}

beforeEach(() => {
  scheduler = new ManualScheduler(10_000);
  singles = [];
  doubles = [];
  make();
});

describe("PressDisambiguator", () => {
  it("emits a single press once the window passes, stamped with the raw press time", () => {
    d.pressCandidate(candidate);
    scheduler.advance(WINDOW - 1);
    expect(singles).toHaveLength(0);
    scheduler.advance(1);
    expect(singles).toEqual([
      expect.objectContaining({
        pressedAtMs: 10_000,
        resolvedAtMs: 10_000 + WINDOW,
        coalescedCount: 0,
      }),
    ]);
  });

  it("CLICK then DOUBLE_CLICK within the window yields only the double press", () => {
    d.pressCandidate(candidate);
    scheduler.advance(180);
    d.doublePress(double);
    scheduler.advance(WINDOW * 3);
    expect(singles).toHaveLength(0);
    expect(doubles).toEqual([expect.objectContaining({ cancelledPendingPress: true })]);
  });

  it("a DOUBLE_CLICK with no preceding CLICK is still just a double press", () => {
    d.doublePress(double);
    scheduler.advance(WINDOW * 3);
    expect(singles).toHaveLength(0);
    expect(doubles).toEqual([expect.objectContaining({ cancelledPendingPress: false })]);
  });

  it("suppresses trailing candidates right after a double press", () => {
    d.doublePress(double);
    scheduler.advance(SUPPRESS - 1);
    d.pressCandidate(candidate);
    scheduler.advance(WINDOW);
    expect(singles).toHaveLength(0);
    expect(d.stats.suppressed).toBe(1);

    d.pressCandidate(candidate); // now past the suppression window
    scheduler.advance(WINDOW);
    expect(singles).toHaveLength(1);
  });

  it("merges duplicate reports of one physical press (textEvent + sysEvent)", () => {
    d.pressCandidate({ ...candidate, source: "unknown", channel: "text" });
    scheduler.advance(5);
    d.pressCandidate(candidate);
    scheduler.advance(WINDOW);
    expect(singles).toEqual([
      expect.objectContaining({ coalescedCount: 1, source: "glasses_right", channel: "text" }),
    ]);
  });

  it("two separate presses further apart than the window are two single presses", () => {
    d.pressCandidate(candidate);
    scheduler.advance(WINDOW + 50);
    d.pressCandidate(candidate);
    scheduler.advance(WINDOW);
    expect(singles.map((s) => s.pressedAtMs)).toEqual([10_000, 10_000 + WINDOW + 50]);
  });

  it("cancelPending drops a held press without emitting it", () => {
    d.pressCandidate(candidate);
    expect(d.hasPendingPress()).toBe(true);
    expect(d.cancelPending()).toBe(true);
    scheduler.advance(WINDOW * 2);
    expect(singles).toHaveLength(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  it("windowMs = 0 emits immediately", () => {
    make(0);
    d.pressCandidate(candidate);
    expect(singles).toHaveLength(1);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  it("dispose clears timers", () => {
    d.pressCandidate(candidate);
    d.dispose();
    expect(scheduler.pendingTimers()).toBe(0);
  });
});
