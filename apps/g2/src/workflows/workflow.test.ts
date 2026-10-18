import { HUD_COPY, SOS_COUNTDOWN_MS } from "@haven/contracts";
import { FIXTURE_NOW_MS, makeAlertEvent } from "@haven/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { HavenAppContext } from "../core/app-context";
import { silentLog } from "../core/log";
import { createHudRenderer } from "../hud";
import {
  FakeBridge,
  FakeInputController,
  ManualScheduler,
  MockApiClient,
  MockAudioService,
  MockDeviceService,
} from "../testing";
import { ALERT_POLL_INTERVAL_MS, createHavenWorkflow, type HavenWorkflow } from ".";

const CLICK_WINDOW_MS = 400;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Haven SOS workflow", () => {
  let bridge: FakeBridge;
  let input: FakeInputController;
  let scheduler: ManualScheduler;
  let api: MockApiClient;
  let audio: MockAudioService;
  let devices: MockDeviceService;
  let ctx: HavenAppContext;
  let workflow: HavenWorkflow;

  beforeEach(async () => {
    bridge = new FakeBridge();
    input = new FakeInputController();
    scheduler = new ManualScheduler(FIXTURE_NOW_MS);
    api = new MockApiClient();
    audio = new MockAudioService();
    devices = new MockDeviceService();
    ctx = {
      config: { apiBaseUrl: "http://api.test", clickDisambiguationMs: CLICK_WINDOW_MS },
      bridge,
      scheduler,
      log: silentLog,
      input,
      api,
      audio,
      devices,
    } as unknown as HavenAppContext;
    workflow = createHavenWorkflow(ctx);
    await workflow.ready;
    await flush();
  });

  const startCountdown = () => {
    input.press(scheduler.now());
    expect(workflow.state).toBe("COUNTDOWN");
  };

  const finishCountdown = async () => {
    scheduler.advance(SOS_COUNTDOWN_MS + CLICK_WINDOW_MS);
    await flush();
  };

  it("starts from a visually blank, event-capturing HUD and begins countdown on one press", async () => {
    expect(bridge.textUpgrades).toHaveLength(0);
    startCountdown();
    await flush();
    expect(bridge.textUpgrades.at(-1)?.content).toContain(HUD_COPY.countdownQuestion);
    expect(bridge.textUpgrades.at(-1)?.content).toContain("\n5");
  });

  it("cancels completely when a press occurred before the five-second deadline", async () => {
    startCountdown();
    scheduler.advance(SOS_COUNTDOWN_MS - 25);
    input.press(scheduler.now(), scheduler.now() + CLICK_WINDOW_MS);
    scheduler.advance(CLICK_WINDOW_MS + 100);
    await flush();
    expect(workflow.state).toBe("IDLE");
    expect(api.createAlertRequests).toHaveLength(0);
    expect(audio.calls).toEqual([]);
    expect(bridge.textUpgrades.at(-1)?.content).toBe(" ");
  });

  it("shows 5 through 1 from an absolute deadline and creates exactly one alert after the guard window", async () => {
    startCountdown();
    for (const expected of [4, 3, 2, 1]) {
      scheduler.advance(1_000);
      await flush();
      expect(bridge.textUpgrades.at(-1)?.content).toContain(`\n${expected}`);
    }
    scheduler.advance(1_000);
    await flush();
    expect(api.createAlertRequests).toHaveLength(0);
    scheduler.advance(CLICK_WINDOW_MS);
    await flush();
    expect(api.createAlertRequests).toHaveLength(1);
    expect(workflow.state).toBe("WAITING_FOR_PHOTON");
    expect(api.createAlertRequests[0]?.activatedAt).toBe(FIXTURE_NOW_MS);
  });

  it("ignores double presses and all presses while submitting", async () => {
    input.emit({
      kind: "double_press",
      pressedAtMs: scheduler.now(),
      channel: "sys",
      source: "glasses_right",
    });
    expect(workflow.state).toBe("IDLE");
    expect(api.createAlertRequests).toHaveLength(0);

    let resolveSnapshot!: () => void;
    devices.getEmergencySnapshot = async () => {
      await new Promise<void>((resolve) => (resolveSnapshot = resolve));
      return devices.snapshot;
    };
    startCountdown();
    scheduler.advance(SOS_COUNTDOWN_MS + CLICK_WINDOW_MS);
    expect(workflow.state).toBe("SUBMITTING_SOS");
    input.press(scheduler.now());
    input.press(scheduler.now());
    resolveSnapshot();
    await flush();
    expect(api.createAlertRequests).toHaveLength(1);
  });

  it("does not start audio from the create-alert response; the acceptance event starts it once", async () => {
    startCountdown();
    await finishCountdown();
    expect(audio.calls).toEqual([]);
    api.pushEvent(
      makeAlertEvent({
        type: "alert.initial_notification_accepted",
        payload: { acceptedCount: 1, totalRecipients: 2 },
      }),
    );
    scheduler.advance(ALERT_POLL_INTERVAL_MS);
    await flush();
    expect(workflow.state).toBe("RECORDING");
    expect(audio.calls).toEqual([`start:${api.alert.alertId}`]);

    scheduler.advance(ALERT_POLL_INTERVAL_MS);
    await flush();
    expect(audio.calls).toEqual([`start:${api.alert.alertId}`]);
  });

  it("uses the next recording press only to send audio and ignores further upload presses", async () => {
    startCountdown();
    api.pushEvent(
      makeAlertEvent({
        type: "alert.initial_notification_accepted",
        payload: { acceptedCount: 1, totalRecipients: 1 },
      }),
    );
    await finishCountdown();
    await flush();
    expect(workflow.state).toBe("RECORDING");

    let resolveUpload!: () => void;
    const result = audio.submitResult;
    audio.stopAndSendRecording = async (activeAlertId) => {
      audio.calls.push(`stop:${activeAlertId}`);
      await new Promise<void>((resolve) => (resolveUpload = resolve));
      return result;
    };
    input.press(scheduler.now());
    expect(workflow.state).toBe("UPLOADING_AUDIO");
    input.press(scheduler.now());
    expect(audio.calls.filter((call) => call.startsWith("stop:"))).toHaveLength(1);
    expect(api.createAlertRequests).toHaveLength(1);
    resolveUpload();
    await flush();
    expect(workflow.state).toBe("ACTIVE_ALERT");
    expect(api.createAlertRequests).toHaveLength(1);
  });

  it("shows authenticated contact replies once and resumes after a polling failure", async () => {
    let failPoll = true;
    const realGetEvents = api.getAlertEvents.bind(api);
    api.getAlertEvents = async (...args) => {
      if (failPoll) {
        failPoll = false;
        throw new Error("offline");
      }
      return realGetEvents(...args);
    };
    startCountdown();
    await finishCountdown();
    api.pushEvent(
      makeAlertEvent(
        {
          type: "contact.responded",
          payload: {
            contactId: api.contacts.contacts[0]!.id,
            displayName: "Mom",
            text: "I received your alert.",
            receivedAt: FIXTURE_NOW_MS,
          },
        },
        { id: 8 },
      ),
    );
    scheduler.advance(ALERT_POLL_INTERVAL_MS);
    await flush();
    scheduler.advance(ALERT_POLL_INTERVAL_MS);
    await flush();
    const content = bridge.textUpgrades.at(-1)?.content ?? "";
    expect(content.match(/Mom: I received your alert\./g)).toHaveLength(1);
  });

  it("reports an initial notification failure honestly and requires explicit reset", async () => {
    startCountdown();
    api.pushEvent(
      makeAlertEvent({
        type: "alert.initial_notification_failed",
        payload: { reason: "no_eligible_contacts", totalRecipients: 0 },
      }),
    );
    await finishCountdown();
    await flush();
    expect(workflow.state).toBe("ERROR");
    expect(bridge.textUpgrades.at(-1)?.content).toContain("No eligible emergency contacts");
    input.press(scheduler.now());
    expect(workflow.state).toBe("ERROR");
    await workflow.reset();
    await flush();
    expect(workflow.state).toBe("IDLE");
  });
});

describe("HUD rendering", () => {
  it("serializes upgrades and keeps the required copy/provider wording", async () => {
    const bridge = new FakeBridge();
    const hud = createHudRenderer(bridge);
    await hud.render({
      state: "RECORDING",
      acceptedCount: 2,
      totalRecipients: 3,
      recordingElapsedMs: 7_500,
      replies: [],
    });
    expect(bridge.textUpgrades.at(-1)?.content).toBe(
      [
        HUD_COPY.sosSent,
        "Accepted by Photon 2/3",
        `${HUD_COPY.recording} 0:07`,
        HUD_COPY.recordingHint,
      ].join("\n"),
    );
  });

  it("rebuilds the single event-capture container when an in-place update is rejected", async () => {
    const bridge = new FakeBridge();
    bridge.textContainerUpgrade = async (container) => {
      bridge.textUpgrades.push(container);
      return false;
    };
    const hud = createHudRenderer(bridge);
    await hud.render({ state: "SUBMITTING_SOS" });
    expect(bridge.rebuilds).toHaveLength(1);
    expect(bridge.rebuilds[0]?.containerTotalNum).toBe(1);
    expect(bridge.rebuilds[0]?.textObject?.[0]).toMatchObject({
      containerID: 1,
      content: "Sending SOS...",
      isEventCapture: 1,
    });
  });
});
