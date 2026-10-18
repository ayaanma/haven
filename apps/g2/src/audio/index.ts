import { AudioInputSource, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import {
  apiPaths,
  AUDIO_CHUNK_CONTENT_TYPE,
  CompleteAudioResponseSchema,
  UploadAudioChunkResponseSchema,
  G2_PCM_BYTES_PER_SECOND,
  MAX_RECORDING_DURATION_MS,
  AlertIdSchema,
  RecordingIdSchema,
  RECORDING_SHARE_LINK_TTL_MS,
} from "@haven/contracts";
import type {
  AudioServiceDeps,
  HavenAudioService,
  RecordingStartResult,
  RecordingSubmitResult,
  AudioRecordingProgress,
} from "../core/interfaces";
import { HavenApiError } from "../core/http";
import type { TimerHandle } from "../core/scheduler";
import { createAudioJournal, type AudioCheckpoint } from "./journal";

export type AudioState =
  | "IDLE"
  | "STARTING"
  | "RECORDING"
  | "STOPPING"
  | "UPLOADING"
  | "FINALIZING"
  | "COMPLETE"
  | "FAILED";
export const AUDIO_CHUNK_BYTES = 64 * 1024;
export const MAX_PENDING_AUDIO_BYTES = 2 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 5_000;
const BRIDGE_TIMEOUT_MS = 5_000;
const allowed: Record<AudioState, AudioState[]> = {
  IDLE: ["STARTING", "FAILED"],
  STARTING: ["RECORDING", "STOPPING", "FAILED", "IDLE"],
  RECORDING: ["STOPPING", "FAILED"],
  STOPPING: ["UPLOADING", "FAILED", "IDLE"],
  UPLOADING: ["FINALIZING", "FAILED", "IDLE"],
  FINALIZING: ["COMPLETE", "FAILED", "IDLE"],
  COMPLETE: ["IDLE"],
  FAILED: ["STOPPING", "UPLOADING", "IDLE"],
};
const phases: Record<AudioState, AudioRecordingProgress["phase"]> = {
  IDLE: "idle",
  STARTING: "idle",
  RECORDING: "recording",
  STOPPING: "stopping",
  UPLOADING: "uploading",
  FINALIZING: "notifying",
  COMPLETE: "sent",
  FAILED: "failed",
};

export function createAudioService(deps: AudioServiceDeps): HavenAudioService {
  let state: AudioState = "IDLE";
  let capture: AudioCheckpoint | null = null;
  let requestedAlertId: string | null = null;
  const buffer = new Uint8Array(AUDIO_CHUNK_BYTES);
  let used = 0;
  let lastFrameAt = 0;
  let captureStoppedAt = 0;
  let timer: TimerHandle;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeDevice: (() => void) | undefined;
  let startTask: Promise<RecordingStartResult> | null = null;
  let submitTask: Promise<RecordingSubmitResult> | null = null;
  let uploadTask: Promise<void> | null = null;
  let finalResult: RecordingSubmitResult | null = null;
  let uploadError: unknown = null;
  let stopRequested = false;
  let disposed = false;
  const journal = createAudioJournal();
  const requests = new AbortController();
  const listeners = new Set<(progress: AudioRecordingProgress) => void>();

  function progress(): AudioRecordingProgress {
    return {
      phase: phases[state],
      recordingId: capture?.recordingId ?? null,
      elapsedMs: capture
        ? Math.max(0, (captureStoppedAt || deps.scheduler.now()) - capture.startedAtMs)
        : 0,
      uploadedChunks: capture?.uploadedChunks ?? 0,
      pendingChunks: (capture?.chunks.length ?? 0) + (used > 0 ? 1 : 0),
    };
  }
  function emit() {
    for (const listener of listeners) {
      try {
        listener(progress());
      } catch {
        deps.log.warn("Audio progress listener failed");
      }
    }
  }
  function transition(next: AudioState) {
    if (state === next) return;
    if (!allowed[state].includes(next))
      throw new Error(`Invalid audio transition ${state} -> ${next}`);
    state = next;
    emit();
  }
  function checkpoint() {
    if (!capture) return Promise.resolve();
    capture.tail = buffer.slice(0, used);
    return journal.save(capture).catch(() => {
      // Keep evidence in memory and stop capture before losing the bounded buffer.
      deps.log.warn("Audio checkpoint unavailable; evidence remains in memory");
    });
  }
  function bounded<T>(operation: Promise<T>): Promise<T> {
    let handle: TimerHandle;
    return Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        handle = deps.scheduler.setTimeout(
          () => reject(new Error("Microphone command timed out")),
          BRIDGE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => deps.scheduler.clearTimeout(handle));
  }
  function detach() {
    deps.scheduler.clearTimeout(timer);
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeDevice?.();
    unsubscribeDevice = undefined;
  }
  async function closeMicrophone(): Promise<boolean> {
    try {
      return await bounded(deps.bridge.audioControl(false));
    } catch {
      return false;
    }
  }
  function interrupt() {
    if (state !== "STARTING" && state !== "RECORDING") return;
    stopRequested = true;
    captureStoppedAt = deps.scheduler.now();
    detach();
    transition("FAILED");
    flush();
    void closeMicrophone();
    void checkpoint();
  }
  async function digest(bytes: Uint8Array): Promise<string> {
    const result = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const retryable = (error: unknown) => (error instanceof HavenApiError ? error.retryable : false);
  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (disposed) throw new Error("Audio service disposed");
      try {
        return await operation();
      } catch (error) {
        if (disposed || attempt >= 2 || !retryable(error)) throw error;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            deps.scheduler.clearTimeout(handle);
            reject(new Error("Audio service disposed"));
          };
          const handle = deps.scheduler.setTimeout(
            () => {
              requests.signal.removeEventListener("abort", onAbort);
              resolve();
            },
            250 * 2 ** attempt,
          );
          requests.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }
  function pump(): Promise<void> {
    if (uploadTask) return uploadTask;
    const current = capture;
    if (!current || disposed) return Promise.resolve();
    uploadTask = (async () => {
      while (current.chunks.length && !disposed) {
        const chunk = current.chunks[0]!;
        const sha256 = await digest(chunk.bytes);
        if (disposed) return;
        await retry(() =>
          deps.http.binary({
            method: "POST",
            path: apiPaths.audioChunks(current.alertId),
            query: { recordingId: current.recordingId, index: chunk.index, sha256 },
            body: chunk.bytes,
            contentType: AUDIO_CHUNK_CONTENT_TYPE,
            schema: UploadAudioChunkResponseSchema,
            signal: requests.signal,
          }),
        );
        if (disposed) return;
        current.chunks.shift();
        current.uploadedChunks++;
        uploadError = null;
        await checkpoint();
        emit();
      }
    })()
      .catch((error) => {
        uploadError = error;
        // Failure does not discard or renumber the chunk. A later stop retries it.
        if (state === "RECORDING") interrupt();
        emit();
      })
      .finally(() => {
        uploadTask = null;
      });
    return uploadTask;
  }
  function flush() {
    if (!capture || !used) return;
    capture.chunks.push({ index: capture.nextIndex++, bytes: buffer.slice(0, used) });
    used = 0;
    void checkpoint();
    void pump();
  }
  function receive(bytes: Uint8Array) {
    if (!capture || !bytes.length) return;
    const pending = capture.chunks.reduce((n, c) => n + c.bytes.length, used);
    if (
      pending + bytes.length > MAX_PENDING_AUDIO_BYTES ||
      capture.totalBytes + bytes.length >
        (G2_PCM_BYTES_PER_SECOND * MAX_RECORDING_DURATION_MS) / 1000
    ) {
      interrupt();
      return;
    }
    lastFrameAt = deps.scheduler.now();
    if (state === "STARTING" && !capture.totalBytes) capture.startedAtMs = lastFrameAt;
    capture.totalBytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(bytes.length - offset, buffer.length - used);
      // Copy immediately; the SDK is free to reuse its input buffer.
      buffer.set(bytes.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === buffer.length) flush();
    }
  }
  function tick() {
    if (state !== "RECORDING") return;
    const now = deps.scheduler.now();
    if (
      now - lastFrameAt >= FRAME_TIMEOUT_MS ||
      now - capture!.startedAtMs >= MAX_RECORDING_DURATION_MS
    ) {
      interrupt();
      return;
    }
    flush();
    void checkpoint();
    emit();
    timer = deps.scheduler.setTimeout(tick, 1000);
  }

  async function restore(alertId: string): Promise<boolean> {
    const saved = await journal.load();
    if (!saved) return false;
    if (
      saved.totalBytes === 0 ||
      saved.startedAtMs + RECORDING_SHARE_LINK_TTL_MS <= deps.scheduler.now()
    ) {
      await journal.save(null);
      return false;
    }
    if (
      saved.alertId !== alertId ||
      !RecordingIdSchema.safeParse(saved.recordingId).success ||
      saved.chunks.reduce((n, c) => n + c.bytes.length, saved.tail.length) > MAX_PENDING_AUDIO_BYTES
    )
      throw new Error("A different audio recording is pending");
    capture = saved;
    requestedAlertId = saved.alertId;
    used = saved.tail.length;
    buffer.set(saved.tail);
    captureStoppedAt =
      saved.startedAtMs + Math.round((saved.totalBytes * 1000) / G2_PCM_BYTES_PER_SECOND);
    transition("FAILED");
    return true;
  }
  async function start(alertId: string): Promise<RecordingStartResult> {
    try {
      if (await restore(alertId))
        return {
          ok: false,
          reason: "already_recording",
          detail: "Captured evidence is pending submission",
        };
    } catch {
      return {
        ok: false,
        reason: "bridge_error",
        detail: "Pending evidence could not be restored",
      };
    }
    if (disposed || stopRequested) return { ok: false, reason: "bridge_error" };
    capture = {
      alertId,
      recordingId: crypto.randomUUID(),
      startedAtMs: deps.scheduler.now(),
      totalBytes: 0,
      nextIndex: 0,
      uploadedChunks: 0,
      chunks: [],
      tail: new Uint8Array(),
    };
    emit();
    unsubscribe = deps.bridge.onEvenHubEvent((event) => {
      const type = event.sysEvent?.eventType;
      if (
        type === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
        type === OsEventTypeList.ABNORMAL_EXIT_EVENT ||
        type === OsEventTypeList.SYSTEM_EXIT_EVENT
      )
        interrupt();
      if (
        (state === "RECORDING" || state === "STARTING" || state === "STOPPING") &&
        event.audioEvent?.source === AudioInputSource.Glasses
      )
        receive(event.audioEvent.audioPcm);
    });
    unsubscribeDevice = deps.bridge.onDeviceStatusChanged((status) => {
      // The callback doesn't identify glasses versus ring. Conservatively stop on disconnect.
      if (status.isDisconnected() || status.isConnectionFailed()) interrupt();
    });
    let opened: boolean;
    try {
      const command = deps.bridge.audioControl(true, AudioInputSource.Glasses);
      // If a timed-out open eventually succeeds, close it rather than leaving a live mic.
      void command.then(
        (ok) => {
          if (ok && (disposed || state === "FAILED" || state === "IDLE")) void closeMicrophone();
        },
        () => {},
      );
      opened = await bounded(command);
    } catch {
      detach();
      if (state !== "FAILED" && state !== "IDLE") transition("FAILED");
      await closeMicrophone();
      return { ok: false, reason: "bridge_error" };
    }
    if (!opened) {
      detach();
      if (state !== "FAILED" && state !== "IDLE") transition("FAILED");
      await closeMicrophone();
      return { ok: false, reason: "microphone_unavailable" };
    }
    if (disposed || state === "FAILED" || state === "IDLE") {
      await closeMicrophone();
      return { ok: false, reason: "bridge_error" };
    }
    if (!capture.totalBytes) capture.startedAtMs = deps.scheduler.now();
    lastFrameAt = deps.scheduler.now();
    if (!stopRequested) {
      transition("RECORDING");
      timer = deps.scheduler.setTimeout(tick, 1000);
    }
    await checkpoint();
    return { ok: true, recordingId: capture.recordingId, startedAtMs: capture.startedAtMs };
  }
  async function submit(alertId: string): Promise<RecordingSubmitResult> {
    if (startTask) await startTask;
    if (!capture) {
      try {
        await restore(alertId);
      } catch {
        return { ok: false, reason: "upload_failed", retryable: true };
      }
    }
    if (!capture || capture.alertId !== alertId || disposed)
      return { ok: false, reason: "not_recording", retryable: false };
    const current = capture;
    if (state === "RECORDING" || state === "FAILED") transition("STOPPING");
    const closed = await closeMicrophone();
    detach();
    captureStoppedAt ||= deps.scheduler.now();
    if (!closed) {
      transition("FAILED");
      await checkpoint();
      return {
        ok: false,
        reason: "finalize_failed",
        retryable: true,
        detail: "Microphone stop was not confirmed",
      };
    }
    flush();
    if (!current.totalBytes || current.totalBytes % 2) {
      transition("FAILED");
      await checkpoint();
      return {
        ok: false,
        reason: "finalize_failed",
        retryable: false,
        detail: "No complete PCM recording was captured",
      };
    }
    transition("UPLOADING");
    uploadError = null;
    await pump();
    if (disposed) return { ok: false, reason: "not_recording", retryable: false };
    if (current.chunks.length || uploadError) {
      transition("FAILED");
      await checkpoint();
      return {
        ok: false,
        reason: "upload_failed",
        retryable: retryable(uploadError),
        detail: "Captured evidence is retained for retry",
      };
    }
    transition("FINALIZING");
    try {
      const result = await retry(() =>
        deps.http.json({
          method: "POST",
          path: apiPaths.audioComplete(alertId),
          body: {
            recordingId: current.recordingId,
            chunkCount: current.nextIndex,
            durationMs: Math.max(
              1,
              Math.round((current.totalBytes * 1000) / G2_PCM_BYTES_PER_SECOND),
            ),
            startedAt: current.startedAtMs,
          },
          schema: CompleteAudioResponseSchema,
          signal: requests.signal,
        }),
      );
      if (disposed) return { ok: false, reason: "not_recording", retryable: false };
      if (!result.notification.acceptedCount) {
        transition("FAILED");
        return {
          ok: false,
          reason: "finalize_failed",
          retryable: false,
          detail: "Recording saved; no recording notification was accepted",
        };
      }
      finalResult = {
        ok: true,
        recordingId: current.recordingId,
        durationMs: result.recording.durationMs,
        chunkCount: result.recording.chunkCount,
        notification: result.notification,
      };
      transition("COMPLETE");
      await journal.save(null).catch(() => {});
      return finalResult;
    } catch (error) {
      transition("FAILED");
      await checkpoint();
      return {
        ok: false,
        reason: "finalize_failed",
        retryable: retryable(error),
        detail: "Recording completion has not been confirmed",
      };
    }
  }
  return {
    startRecording(alertId) {
      if (!AlertIdSchema.safeParse(alertId).success)
        return Promise.resolve({ ok: false, reason: "bridge_error" });
      if (disposed) return Promise.resolve({ ok: false, reason: "already_recording" });
      if (startTask && requestedAlertId === alertId) return startTask;
      if (state !== "IDLE" || disposed)
        return Promise.resolve({ ok: false, reason: "already_recording" });
      requestedAlertId = alertId;
      transition("STARTING");
      startTask = start(alertId);
      return startTask;
    },
    stopAndSendRecording(alertId) {
      if (
        (requestedAlertId && requestedAlertId !== alertId) ||
        (capture && capture.alertId !== alertId)
      )
        return Promise.resolve({ ok: false, reason: "not_recording", retryable: false });
      if (finalResult) return Promise.resolve(finalResult);
      if (submitTask) return submitTask;
      stopRequested = true;
      if (state === "RECORDING" || state === "STARTING") transition("STOPPING");
      submitTask = submit(alertId).finally(() => {
        submitTask = null;
      });
      return submitTask;
    },
    async disposeRecording() {
      disposed = true;
      requests.abort();
      stopRequested = true;
      detach();
      if (state !== "IDLE" && state !== "COMPLETE") {
        await closeMicrophone();
        captureStoppedAt ||= deps.scheduler.now();
        flush();
        await checkpoint();
      }
      if (state === "RECORDING") transition("STOPPING");
      transition("IDLE");
      listeners.clear();
    },
    onProgress(listener) {
      listeners.add(listener);
      listener(progress());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
