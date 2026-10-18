import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioEvent,
  AudioInputSource,
  DeviceStatus,
  DeviceConnectType,
  OsEventTypeList,
  Sys_ItemEvent,
} from "@evenrealities/even_hub_sdk";
import { fixtureId } from "@haven/contracts/testing";
import type { AudioRecordingProgress, HavenAudioService } from "../core/interfaces";
import { createHttpClient } from "../core/http";
import { silentLog } from "../core/log";
import { FakeBridge, ManualScheduler } from "../testing";
import { createAudioService, AUDIO_CHUNK_BYTES, MAX_PENDING_AUDIO_BYTES } from "./index";
import { fakeAudioIndexedDB } from "./testing/fake-indexed-db";

const alertId = fixtureId("alt");
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
/** Upload/finalize retry backoffs (250 ms, then 500 ms) are the only timers this short. */
const RETRY_BACKOFFS_MS = new Set([250, 500]);
describe("G2 emergency microphone and uploader", () => {
  let bridge: FakeBridge;
  let scheduler: ManualScheduler;
  let service: HavenAudioService;
  let progress: AudioRecordingProgress[];
  let uploads: { index: number; recordingId: string; bytes: Uint8Array; sha256: string }[];
  let completions: {
    recordingId: string;
    chunkCount: number;
    durationMs: number;
    startedAt: number;
  }[];
  let failUploads: boolean;
  let failFinalization: boolean;
  let acceptedCount: number;
  let requestPaths: string[];
  let makeService: () => HavenAudioService;
  let retryTimers: number;
  let firedRetries: number;
  /**
   * Waits in real time until the uploader schedules its next retry backoff, then fires it.
   * Hashing (crypto.subtle) runs off-thread, so a fixed number of ticks races on slow CI.
   */
  async function fireNextRetry() {
    const deadline = Date.now() + 4_000;
    while (retryTimers <= firedRetries && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    firedRetries++;
    scheduler.advance(500);
    await settle();
  }
  function frame(bytes = new Uint8Array(3200), source = AudioInputSource.Glasses) {
    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: bytes, source }) });
  }
  beforeEach(() => {
    vi.stubGlobal("indexedDB", fakeAudioIndexedDB().factory);
    bridge = new FakeBridge();
    scheduler = new ManualScheduler();
    retryTimers = 0;
    firedRetries = 0;
    const schedule = scheduler.setTimeout.bind(scheduler);
    vi.spyOn(scheduler, "setTimeout").mockImplementation((callback, delayMs) => {
      if (RETRY_BACKOFFS_MS.has(delayMs)) retryTimers++;
      return schedule(callback, delayMs);
    });
    uploads = [];
    completions = [];
    progress = [];
    requestPaths = [];
    failUploads = false;
    failFinalization = false;
    acceptedCount = 1;
    const http = createHttpClient({
      baseUrl: "https://haven.invalid",
      sessions: {
        load: async () => ({ token: "fake-session", expiresAt: Number.MAX_SAFE_INTEGER }),
        save: async () => {},
        clear: async () => {},
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requestPaths.push(url.pathname);
        if (url.pathname.endsWith("/chunks")) {
          if (failUploads) throw new Error("offline");
          const bytes = new Uint8Array(init!.body as Uint8Array);
          uploads.push({
            index: Number(url.searchParams.get("index")),
            recordingId: url.searchParams.get("recordingId")!,
            sha256: url.searchParams.get("sha256")!,
            bytes,
          });
          return Response.json({
            recordingId: url.searchParams.get("recordingId"),
            index: Number(url.searchParams.get("index")),
            status: "stored",
            receivedChunkCount: uploads.length,
          });
        }
        if (failFinalization) throw new Error("offline");
        const body = JSON.parse(init!.body as string);
        completions.push(body);
        return Response.json({
          recording: {
            recordingId: body.recordingId,
            alertId,
            mimeType: "audio/wav",
            durationMs: body.durationMs,
            chunkCount: body.chunkCount,
            byteLength: 44 + uploads.reduce((n, u) => n + u.bytes.length, 0),
            status: "completed",
            createdAt: scheduler.now(),
            completedAt: scheduler.now(),
          },
          notification: { acceptedCount, totalRecipients: 1 },
        });
      },
    });
    makeService = () => createAudioService({ bridge, scheduler, http, log: silentLog });
    service = makeService();
    service.onProgress((value) => progress.push(value));
  });
  afterEach(async () => {
    await service.disposeRecording();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("never opens the mic for idle, countdown, cancellation or SOS submission events", async () => {
    frame();
    bridge.emitHostMessage({ type: "sysEvent", jsonData: { eventType: 0, eventSource: 1 } });
    scheduler.advance(5000);
    bridge.emitHostMessage({ type: "sysEvent", jsonData: { eventType: 0, eventSource: 1 } });
    bridge.emit({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }) });
    expect(bridge.audioCalls).toEqual([]);
    expect(uploads).toEqual([]);
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(false);
    expect(bridge.audioCalls).toEqual([]);
  });

  it("starts once only when explicitly called after Agent 1's acceptance transition", async () => {
    const first = service.startRecording(alertId);
    expect(service.startRecording(alertId)).toBe(first);
    const started = await first;
    expect(started.ok).toBe(true);
    expect(bridge.audioCalls).toEqual([{ isOpen: true, source: AudioInputSource.Glasses }]);
    expect(await service.startRecording(alertId)).toEqual(started);
    expect((await service.startRecording(fixtureId("alt", 2))).ok).toBe(false);
    frame();
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });

  it("processes SDK-parsed PCM, ignores phone audio, and copies reusable buffers", async () => {
    await service.startRecording(alertId);
    frame(new Uint8Array(6400), AudioInputSource.Phone);
    const original = new Uint8Array([0, 128, 255, 127]);
    frame(original);
    original.fill(42);
    bridge.emitHostMessage({
      type: "audioEvent",
      jsonData: { source: "glasses", audioPcm: [1, 2, 3, 4] },
    });
    const result = await service.stopAndSendRecording(alertId);
    expect(result.ok).toBe(true);
    expect(uploads.flatMap((u) => [...u.bytes])).toEqual([0, 128, 255, 127, 1, 2, 3, 4]);
  });

  it("updates duration from the clock and streams before the stop press", async () => {
    await service.startRecording(alertId);
    frame();
    scheduler.advance(1000);
    await vi.waitFor(() => {
      expect(progress.some((p) => p.elapsedMs === 1000 && p.phase === "recording")).toBe(true);
      expect(uploads).toHaveLength(1);
    });
    expect(completions).toHaveLength(0);
    frame();
    const result = await service.stopAndSendRecording(alertId);
    expect(result).toMatchObject({ ok: true, durationMs: 200 });
    // Playback duration is based on captured samples, not the wall-clock gap.
    expect(completions[0]?.durationMs).toBe(200);
  });

  it("keeps the recording timer stable when the first microphone frame is delayed", async () => {
    await service.startRecording(alertId);
    scheduler.advance(1000);
    frame();
    scheduler.advance(1000);
    expect(progress.at(-1)?.elapsedMs).toBe(2000);
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });

  it("atomically stops once and never submits another SOS on rapid repeated stops", async () => {
    await service.startRecording(alertId);
    frame();
    const first = service.stopAndSendRecording(alertId);
    expect(service.stopAndSendRecording(alertId)).toBe(first);
    const result = await first;
    expect(result).toMatchObject({ ok: true, notification: { acceptedCount: 1 } });
    expect(await service.stopAndSendRecording(alertId)).toEqual(result);
    expect(bridge.audioCalls.filter((c) => !c.isOpen)).toHaveLength(1);
    expect(completions).toHaveLength(1);
    expect(
      requestPaths.every((p) => p.endsWith("/audio/chunks") || p.endsWith("/audio/complete")),
    ).toBe(true);
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(["recording", "stopping", "uploading", "notifying", "sent"]),
    );
  });

  it("does not let an unrelated alert stop the active microphone", async () => {
    await service.startRecording(alertId);
    frame();
    expect(await service.stopAndSendRecording(fixtureId("alt", 2))).toMatchObject({
      ok: false,
      reason: "not_recording",
    });
    expect(bridge.audioCalls.filter((c) => !c.isOpen)).toHaveLength(0);
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });

  it("isolates alert IDs before asynchronous startup has allocated a recording", async () => {
    const first = service.startRecording(alertId);
    const other = fixtureId("alt", 2);
    expect(await service.startRecording(other)).toMatchObject({
      ok: false,
      reason: "already_recording",
    });
    expect(await service.stopAndSendRecording(other)).toMatchObject({
      ok: false,
      reason: "not_recording",
    });
    expect((await first).ok).toBe(true);
    frame();
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });

  it("splits PCM into bounded sequential chunks and flushes the final tail", async () => {
    await service.startRecording(alertId);
    const bytes = new Uint8Array(AUDIO_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    frame(bytes);
    const result = await service.stopAndSendRecording(alertId);
    expect(result).toMatchObject({ ok: true, chunkCount: 3 });
    expect(uploads.map((u) => u.index)).toEqual([0, 1, 2]);
    expect(uploads.map((u) => u.bytes.length)).toEqual([AUDIO_CHUNK_BYTES, AUDIO_CHUNK_BYTES, 10]);
    expect(new Uint8Array(uploads.flatMap((u) => [...u.bytes]))).toEqual(bytes);
    expect(new Set(uploads.map((u) => u.recordingId)).size).toBe(1);
    for (const chunk of uploads) {
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", chunk.bytes as Uint8Array<ArrayBuffer>),
      );
      expect(chunk.sha256).toBe(Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(""));
    }
  });

  it("retries a temporary network failure with identical chunk identity", async () => {
    failUploads = true;
    await service.startRecording(alertId);
    frame();
    const pending = service.stopAndSendRecording(alertId);
    await fireNextRetry();
    failUploads = false;
    await fireNextRetry();
    expect(await pending).toMatchObject({ ok: true });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.index).toBe(0);
  });

  it("retains evidence after retry exhaustion, then resumes the same recording", async () => {
    failUploads = true;
    await service.startRecording(alertId);
    frame();
    const pending = service.stopAndSendRecording(alertId);
    await fireNextRetry();
    await fireNextRetry();
    expect(await pending).toMatchObject({ ok: false, reason: "upload_failed", retryable: true });
    expect(completions).toHaveLength(0);
    expect(progress.at(-1)?.pendingChunks).toBe(1);
    const id = progress.at(-1)?.recordingId;
    failUploads = false;
    expect(await service.stopAndSendRecording(alertId)).toMatchObject({
      ok: true,
      recordingId: id,
    });
    expect(uploads).toHaveLength(1);
  });

  it("retains completion metadata when finalization is temporarily unavailable", async () => {
    failFinalization = true;
    await service.startRecording(alertId);
    frame();
    const pending = service.stopAndSendRecording(alertId);
    await fireNextRetry();
    await fireNextRetry();
    expect(await pending).toMatchObject({ ok: false, reason: "finalize_failed", retryable: true });
    failFinalization = false;
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
    expect(uploads).toHaveLength(1);
  });

  it("does not claim notification acceptance when the backend accepted none", async () => {
    acceptedCount = 0;
    await service.startRecording(alertId);
    frame();
    expect(await service.stopAndSendRecording(alertId)).toMatchObject({
      ok: false,
      reason: "finalize_failed",
    });
    expect(progress.some((p) => p.phase === "sent")).toBe(false);
  });

  it("handles permission denial, bridge rejection and missing microphone frames", async () => {
    vi.spyOn(bridge, "audioControl").mockImplementation(async (open) => !open);
    expect(await service.startRecording(alertId)).toMatchObject({
      ok: false,
      reason: "microphone_unavailable",
    });
    expect(progress.at(-1)?.phase).toBe("failed");
  });

  it("reports a rejected microphone command", async () => {
    vi.spyOn(bridge, "audioControl").mockRejectedValue(new Error("permission denied"));
    expect(await service.startRecording(alertId)).toMatchObject({
      ok: false,
      reason: "bridge_error",
    });
  });

  it("stops honestly when frames disappear and allows sending previously captured audio", async () => {
    await service.startRecording(alertId);
    frame();
    scheduler.advance(5000);
    await vi.waitFor(() => {
      expect(progress.at(-1)?.phase).toBe("failed");
      expect(bridge.audioCalls.filter((c) => !c.isOpen).length).toBeGreaterThan(0);
    });
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });

  it("rejects an empty recording and incomplete PCM samples", async () => {
    await service.startRecording(alertId);
    frame(new Uint8Array([1]));
    expect(await service.stopAndSendRecording(alertId)).toMatchObject({
      ok: false,
      reason: "finalize_failed",
      retryable: false,
    });
    expect(completions).toHaveLength(0);
  });

  it("does not finalize or notify when the microphone returns no audio", async () => {
    await service.startRecording(alertId);
    expect(await service.stopAndSendRecording(alertId)).toMatchObject({
      ok: false,
      reason: "finalize_failed",
    });
    expect(completions).toHaveLength(0);
  });

  it("preserves sample alignment across odd-sized SDK event fragments", async () => {
    await service.startRecording(alertId);
    frame(new Uint8Array([1]));
    frame(new Uint8Array([2, 3, 4]));
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
    expect(uploads[0]?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("can stop before startup has opened the microphone", async () => {
    const starting = service.startRecording(alertId);
    const stopping = service.stopAndSendRecording(alertId);
    expect((await starting).ok).toBe(false);
    expect((await stopping).ok).toBe(false);
    expect(bridge.audioCalls).toHaveLength(0);
  });

  it("bounds evidence in memory and stops capture before accepting excess data", async () => {
    await service.startRecording(alertId);
    frame(new Uint8Array(MAX_PENDING_AUDIO_BYTES));
    frame(new Uint8Array(2));
    expect(progress.at(-1)?.phase).toBe("failed");
    expect(bridge.audioCalls.some((c) => !c.isOpen)).toBe(true);
    await settle();
  });

  it("handles stop during a delayed microphone startup without leaving capture active", async () => {
    let open!: (ok: boolean) => void;
    vi.spyOn(bridge, "audioControl").mockImplementation(async (isOpen) =>
      isOpen
        ? new Promise<boolean>((resolve) => {
            open = resolve;
          })
        : true,
    );
    const starting = service.startRecording(alertId);
    await settle();
    const stopping = service.stopAndSendRecording(alertId);
    open(true);
    await starting;
    await stopping;
    expect(bridge.audioCalls).toHaveLength(0); // spy replaces the fake's implementation
    expect(bridge.audioControl).toHaveBeenCalledWith(false);
    expect(progress.at(-1)?.phase).toBe("failed"); // no PCM, never "sent"
  });

  it("handles startup timeout and closes a late successful open", async () => {
    let open!: (ok: boolean) => void;
    const control = vi.spyOn(bridge, "audioControl").mockImplementation(async (isOpen) =>
      isOpen
        ? new Promise<boolean>((resolve) => {
            open = resolve;
          })
        : true,
    );
    const starting = service.startRecording(alertId);
    await settle();
    scheduler.advance(5000);
    await settle();
    expect(await starting).toMatchObject({ ok: false, reason: "bridge_error" });
    open(true);
    await vi.waitFor(() => {
      expect(control.mock.calls.filter((c) => c[0] === false).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("stops on lifecycle exit without sending or reopening on foreground", async () => {
    await service.startRecording(alertId);
    frame();
    bridge.emit({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }),
    });
    bridge.emit({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
    });
    await vi.waitFor(() => {
      expect(progress.at(-1)?.phase).toBe("failed");
      expect(bridge.audioCalls.filter((c) => c.isOpen)).toHaveLength(1);
    });
    expect(completions).toHaveLength(0);
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });

  it("stops on a device disconnection", async () => {
    let onDevice!: (status: DeviceStatus) => void;
    vi.spyOn(bridge, "onDeviceStatusChanged").mockImplementation((callback) => {
      onDevice = callback;
      return () => {};
    });
    await service.startRecording(alertId);
    frame();
    onDevice(new DeviceStatus({ sn: "test", connectType: DeviceConnectType.Disconnected }));
    await vi.waitFor(() => expect(progress.at(-1)?.phase).toBe("failed"));
  });

  it("disposes without finalizing or notifying and releases event subscriptions", async () => {
    await service.startRecording(alertId);
    frame();
    await service.disposeRecording();
    expect(bridge.listenerCount()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    expect(completions).toHaveLength(0);
    expect((await service.startRecording(alertId)).ok).toBe(false);
  });

  it("recovers checkpointed evidence after a cold start without reopening the mic", async () => {
    const started = await service.startRecording(alertId);
    frame();
    scheduler.advance(1000);
    await settle();
    frame(new Uint8Array([1, 2, 3, 4]));
    await service.disposeRecording();
    service = makeService();
    expect(await service.startRecording(alertId)).toMatchObject({
      ok: false,
      reason: "already_recording",
    });
    expect(bridge.audioCalls.filter((call) => call.isOpen)).toHaveLength(1);
    const result = await service.stopAndSendRecording(alertId);
    expect(result).toMatchObject({
      ok: true,
      recordingId: started.ok ? started.recordingId : "",
      chunkCount: 2,
    });
    expect(uploads.map((chunk) => chunk.index)).toEqual([0, 1]);
  });

  it("does not let an empty failed capture block the next service instance", async () => {
    await service.startRecording(alertId);
    await service.stopAndSendRecording(alertId);
    await service.disposeRecording();
    service = makeService();
    expect((await service.startRecording(alertId)).ok).toBe(true);
    frame();
    expect((await service.stopAndSendRecording(alertId)).ok).toBe(true);
  });
});
