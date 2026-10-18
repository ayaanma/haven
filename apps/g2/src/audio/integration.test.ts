import { expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource } from "@evenrealities/even_hub_sdk";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createTestHarness,
  FakeNotificationService,
  seedAlert,
  seedContact,
} from "../../../api/src/testing";
import { createHttpClient } from "../core/http";
import { silentLog } from "../core/log";
import { FakeBridge, ManualScheduler } from "../testing";
import { createAudioService } from "./index";
import { fakeAudioIndexedDB } from "./testing/fake-indexed-db";

it("streams fake G2 microphone PCM through authenticated HTTP into a playable, once-notified WAV", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "haven-audio-integration-"));
  const notifications = new FakeNotificationService();
  const h = createTestHarness({
    env: { AUDIO_STORAGE_PATH: directory },
    overrides: { notifications },
  });
  const bridge = new FakeBridge();
  const scheduler = new ManualScheduler(h.clock.now());
  vi.stubGlobal("indexedDB", fakeAudioIndexedDB().factory);
  const http = createHttpClient({
    baseUrl: "http://haven.test",
    sessions: {
      load: async () => ({ token: h.token, expiresAt: Number.MAX_SAFE_INTEGER }),
      save: async () => {},
      clear: async () => {},
    },
    fetch: async (input, init) =>
      h.request(new URL(String(input)).pathname + new URL(String(input)).search, init),
  });
  const audio = createAudioService({ bridge, scheduler, http, log: silentLog });
  try {
    const contactId = seedContact(h.db);
    notifications.recipients = [{ contactId }];
    const alertId = seedAlert(h.db, { now: h.clock.now() });
    h.db.run(
      "UPDATE alerts SET session_id = ? WHERE id = ?",
      h.container.sessions.authenticate(h.token)!.sessionId,
      alertId,
    );
    expect(bridge.audioCalls).toHaveLength(0);
    await audio.startRecording(alertId);
    const pcm = new Uint8Array(3200).map((_, i) => i % 251);
    bridge.emit({
      audioEvent: new AudioEvent({ source: AudioInputSource.Glasses, audioPcm: pcm }),
    });
    scheduler.advance(1000);
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.db.all("SELECT * FROM recording_chunks")).toHaveLength(1);
    expect(notifications.calls).toHaveLength(0);
    bridge.emit({
      audioEvent: new AudioEvent({ source: AudioInputSource.Glasses, audioPcm: pcm }),
    });
    const stop = audio.stopAndSendRecording(alertId);
    expect(audio.stopAndSendRecording(alertId)).toBe(stop);
    expect(await stop).toMatchObject({
      ok: true,
      durationMs: 200,
      chunkCount: 2,
      notification: { acceptedCount: 1 },
    });
    expect(notifications.calls).toHaveLength(1);
    const call = notifications.calls[0]!;
    if (call.method !== "sendRecordingNotification") throw new Error("Expected recording link");
    const response = await h.request(new URL(call.secureUrl).pathname);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    const wav = new Uint8Array(await response.arrayBuffer());
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(6400);
    expect(wav.slice(44)).toEqual(new Uint8Array([...pcm, ...pcm]));
    expect(await audio.stopAndSendRecording(alertId)).toMatchObject({ ok: true });
    expect(notifications.calls).toHaveLength(1);
    expect(h.db.all("SELECT * FROM alerts")).toHaveLength(1);
  } finally {
    await audio.disposeRecording();
    h.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
});
