import type { HavenBridge } from "../bridge";
import { HUD_CONTAINER } from "../bootstrap";
import type { HavenInputController, HavenInputEvent } from "../interfaces";
import { silentLog, type Log } from "../log";
import { browserScheduler, type Scheduler } from "../scheduler";
import { PressDisambiguator } from "./disambiguator";
import { normalizeHubEvent, type IgnoreReason, type RawHubEvent } from "./normalize";

export interface SdkInputControllerOptions {
  scheduler?: Scheduler;
  captureContainerId?: number;
  clickDisambiguationMs?: number;
  postDoublePressSuppressMs?: number;
  /**
   * Show the system exit dialog on double press (`shutDownPageContainer(1)`). Required by
   * Even Hub QA on the root page; keep it on.
   */
  exitOnDoublePress?: boolean;
  log?: Log;
}

export interface InputDiagnostics {
  rawEvents: number;
  pressCandidates: number;
  ignored: Partial<Record<IgnoreReason, number>>;
  disambiguation: PressDisambiguator["stats"];
}

export interface SdkInputController extends HavenInputController {
  hasPendingPress(): boolean;
  diagnostics(): InputDiagnostics;
}

/**
 * The one HavenInputController implementation, built on `bridge.onEvenHubEvent`.
 * Normalization (normalize.ts) and disambiguation (disambiguator.ts) are documented
 * and tested separately; this class connects them and owns the exit gesture.
 */
export function createSdkInputController(
  bridge: Pick<HavenBridge, "onEvenHubEvent" | "shutDownPageContainer">,
  options: SdkInputControllerOptions = {},
): SdkInputController {
  const scheduler = options.scheduler ?? browserScheduler;
  const log = options.log ?? silentLog;
  const captureContainerId = options.captureContainerId ?? HUD_CONTAINER.id;
  const exitOnDoublePress = options.exitOnDoublePress ?? true;

  let listener: ((event: HavenInputEvent) => void) | null = null;
  let disposed = false;
  const counters = { rawEvents: 0, pressCandidates: 0, ignored: {} as InputDiagnostics["ignored"] };

  const deliver = (event: HavenInputEvent) => {
    log.debug(`input ${event.kind}`, event);
    if (!listener) return;
    try {
      listener(event);
    } catch (error) {
      log.error("input listener threw", String(error));
    }
  };

  const disambiguator = new PressDisambiguator({
    scheduler,
    ...(options.clickDisambiguationMs !== undefined
      ? { windowMs: options.clickDisambiguationMs }
      : {}),
    ...(options.postDoublePressSuppressMs !== undefined
      ? { postDoublePressSuppressMs: options.postDoublePressSuppressMs }
      : {}),
    onSinglePress: (press) =>
      deliver({
        kind: "single_press",
        pressedAtMs: press.pressedAtMs,
        resolvedAtMs: press.resolvedAtMs,
        channel: press.channel,
        source: press.source,
        eventTypeOmitted: press.eventTypeOmitted,
      }),
    onDoublePress: (press) => {
      if (exitOnDoublePress) {
        bridge.shutDownPageContainer(1).catch((error: unknown) => {
          log.error("shutDownPageContainer(1) failed", String(error));
        });
      }
      deliver({
        kind: "double_press",
        pressedAtMs: press.pressedAtMs,
        channel: press.channel,
        source: press.source,
      });
    },
  });

  const unsubscribeBridge = bridge.onEvenHubEvent((event) => {
    if (disposed) return;
    counters.rawEvents++;
    for (const signal of normalizeHubEvent(event as RawHubEvent, { captureContainerId })) {
      switch (signal.kind) {
        case "press_candidate":
          counters.pressCandidates++;
          disambiguator.pressCandidate(signal);
          break;
        case "double_press":
          disambiguator.doublePress(signal);
          break;
        case "lifecycle":
          // A press held while the app leaves the foreground must not fire later.
          if (signal.lifecycle !== "foreground_enter") disambiguator.cancelPending();
          deliver({ kind: "lifecycle", lifecycle: signal.lifecycle, atMs: scheduler.now() });
          break;
        case "ignored":
          counters.ignored[signal.reason] = (counters.ignored[signal.reason] ?? 0) + 1;
          break;
      }
    }
  });

  return {
    subscribe(callback) {
      if (disposed) throw new Error("Input controller is disposed");
      listener = callback;
    },
    unsubscribe() {
      listener = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listener = null;
      disambiguator.dispose();
      unsubscribeBridge();
    },
    hasPendingPress: () => disambiguator.hasPendingPress(),
    diagnostics: () => ({
      ...counters,
      ignored: { ...counters.ignored },
      disambiguation: { ...disambiguator.stats },
    }),
  };
}
