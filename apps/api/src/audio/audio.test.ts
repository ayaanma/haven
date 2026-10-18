import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  MAX_AUDIO_CHUNK_BYTES,
  RECORDING_SHARE_LINK_TTL_MS,
  CompleteAudioResponseSchema,
} from "@haven/contracts";
import { createApp } from "../app";
import {
  createTestHarness,
  FakeNotificationService,
  seedAlert,
  seedContact,
  TEST_PAIRING_CODE,
  type TestHarness,
} from "../testing";
import { createRecordingStorage, MAX_RECORDING_BYTES, cleanupExpiredRecordings } from "./index";
import { encodeWav } from "./wav";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe("emergency audio storage and routes", () => {
  let h: TestHarness;
  let directory: string;
  let alertId: string;
  let recordingId: string;
  let notifications: FakeNotificationService;
  const pcm = new Uint8Array(3200).map((_, i) => i % 256);
  const chunkPath = (index = 0, bytes = pcm, id = recordingId, alert = alertId) =>
    `/api/v1/alerts/${alert}/audio/chunks?recordingId=${id}&index=${index}&sha256=${sha(bytes)}`;
  const upload = (index = 0, bytes = pcm) =>
    h.authed(chunkPath(index, bytes), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  const completeBody = (count = 1) => ({
    recordingId,
    chunkCount: count,
    durationMs: count * 100,
    startedAt: h.clock.now() - count * 100,
  });
  const complete = (count = 1) =>
    h.json("POST", `/api/v1/alerts/${alertId}/audio/complete`, completeBody(count));
  function sharePath() {
    const call = notifications.calls.find((c) => c.method === "sendRecordingNotification");
    if (!call || call.method !== "sendRecordingNotification")
      throw new Error("Expected recording notification");
    return new URL(call.secureUrl).pathname;
  }
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "haven-audio-test-"));
    notifications = new FakeNotificationService();
    h = createTestHarness({ env: { AUDIO_STORAGE_PATH: directory }, overrides: { notifications } });
    const contactId = seedContact(h.db);
    notifications.recipients = [{ contactId }];
    alertId = seedAlert(h.db, { now: h.clock.now() });
    h.db.run(
      "UPDATE alerts SET session_id = ? WHERE id = ?",
      h.container.sessions.authenticate(h.token)!.sessionId,
      alertId,
    );
    recordingId = randomUUID();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Tests must never contact real recipients"),
    );
  });
  afterEach(() => {
    h.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("encodes signed little-endian samples with a valid 16 kHz mono WAV header", () => {
    const samples = new Uint8Array([0, 128, 255, 127, 0, 0, 255, 255]);
    const wav = encodeWav(samples);
    const view = new DataView(wav.buffer as ArrayBuffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length);
    expect(wav.slice(44)).toEqual(samples);
    expect(() => encodeWav(new Uint8Array(1))).toThrow();
  });

  it("stores, finalizes and shares playable audio without network calls", async () => {
    expect((await upload()).status).toBe(201);
    expect((await complete()).status).toBe(200);
    const response = await h.request(sharePath());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const wav = new Uint8Array(await response.arrayBuffer());
    expect(wav.length).toBe(3244);
    expect(wav.slice(44)).toEqual(pcm);
    const row = h.db.get<{ duration_ms: number; storage_path: string }>(
      "SELECT * FROM recordings WHERE id = ?",
      recordingId,
    )!;
    expect(row.duration_ms).toBe(100);
    expect(statSync(row.storage_path).mode & 0o777).toBe(0o600);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.container.events.list(alertId).map((e) => e.type)).toEqual([
      "recording.started",
      "recording.upload_completed",
      "recording.notification_accepted",
    ]);
  });

  it("supports out-of-order and duplicate chunks and rejects changed bytes", async () => {
    expect((await upload(1)).status).toBe(201);
    expect((await upload(0)).status).toBe(201);
    expect((await upload(0)).status).toBe(200);
    expect((await upload(0, new Uint8Array(3200))).status).toBe(409);
    expect((await complete(2)).status).toBe(200);
    expect(notifications.calls).toHaveLength(1);
    const bytes = new Uint8Array(await (await h.request(sharePath())).arrayBuffer());
    expect(bytes.slice(44)).toEqual(new Uint8Array([...pcm, ...pcm]));
  });

  it("retries missing chunks without notifying until every index exists", async () => {
    await upload(1);
    const missing = await complete(2);
    expect(missing.status).toBe(409);
    expect(await missing.text()).toContain("Missing audio chunks: 0");
    expect(notifications.calls).toHaveLength(0);
    await upload(0);
    expect((await complete(2)).status).toBe(200);
  });

  it("checks authentication, scope, alert ownership and initial SOS acceptance", async () => {
    expect((await h.request(chunkPath(), { method: "POST", body: pcm })).status).toBe(401);
    const other = h.container.sessions.exchangePairingCode(TEST_PAIRING_CODE)!;
    expect(
      (
        await h.request(chunkPath(), {
          method: "POST",
          headers: { Authorization: `Bearer ${other.sessionToken}` },
          body: pcm,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(`/api/v1/alerts/${alertId}/audio/complete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${other.sessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(completeBody()),
        })
      ).status,
    ).toBe(404);
    h.db.run(
      "UPDATE sessions SET scopes_json = '[]' WHERE id = ?",
      h.container.sessions.authenticate(other.sessionToken)!.sessionId,
    );
    expect(
      (
        await h.request(chunkPath(), {
          method: "POST",
          headers: { Authorization: `Bearer ${other.sessionToken}` },
          body: pcm,
        })
      ).status,
    ).toBe(403);
    h.db.run("UPDATE alerts SET state = 'notifying' WHERE id = ?", alertId);
    expect((await upload()).status).toBe(409);
    h.container.events.append(alertId, {
      type: "alert.initial_notification_accepted",
      payload: { acceptedCount: 1, totalRecipients: 1 },
    });
    expect((await upload()).status).toBe(201);
  });

  it("rejects wrong content type, hash, indexes, paths and empty or oversized chunks", async () => {
    expect(
      (
        await h.authed(chunkPath(), {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: pcm,
        })
      ).status,
    ).toBe(400);
    expect((await upload(0, new Uint8Array())).status).toBe(400);
    expect((await upload(-1)).status).toBe(400);
    expect((await upload(1000)).status).toBe(400);
    expect((await upload(0, new Uint8Array(MAX_AUDIO_CHUNK_BYTES + 1))).status).toBe(413);
    expect(
      (
        await h.authed(chunkPath().replace(sha(pcm), "0".repeat(64)), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: pcm,
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.authed(chunkPath(0, pcm, "../../escape"), { method: "POST", body: pcm })).status,
    ).toBe(400);
  });

  it("enforces total recording size independently of chunk count", async () => {
    const bytes = new Uint8Array(MAX_AUDIO_CHUNK_BYTES);
    for (let i = 0; i < Math.floor(MAX_RECORDING_BYTES / bytes.length); i++) {
      expect((await upload(i, bytes)).status).toBe(201);
    }
    const res = await upload(Math.floor(MAX_RECORDING_BYTES / bytes.length), bytes);
    expect(res.status).toBe(413);
  });

  it("checks PCM sample alignment and duration rather than trusting client metadata", async () => {
    await upload();
    expect(
      (
        await h.json("POST", `/api/v1/alerts/${alertId}/audio/complete`, {
          ...completeBody(),
          durationMs: 101,
        })
      ).status,
    ).toBe(400);
    expect((await complete()).status).toBe(200);
    expect(
      (
        await h.json("POST", `/api/v1/alerts/${alertId}/audio/complete`, {
          ...completeBody(),
          startedAt: 1,
        })
      ).status,
    ).toBe(409);
    expect((await upload(1)).status).toBe(409);
    expect(notifications.calls).toHaveLength(1);
  });

  it("rejects cross-alert recording IDs and multiple recording IDs for one SOS", async () => {
    await upload();
    const otherAlert = seedAlert(h.db);
    h.db.run(
      "UPDATE alerts SET session_id = ? WHERE id = ?",
      h.container.sessions.authenticate(h.token)!.sessionId,
      otherAlert,
    );
    expect(
      (
        await h.authed(chunkPath(0, pcm, recordingId, otherAlert), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: pcm,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.authed(chunkPath(0, pcm, randomUUID()), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: pcm,
        })
      ).status,
    ).toBe(409);
    await expect(
      h.container.recordings.createSecureShareLink({ alertId: otherAlert, recordingId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns the same completion after concurrent requests and API reconstruction", async () => {
    await upload();
    const results = await Promise.all([complete(), complete(), complete()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    const app = createApp(h.container);
    const restarted = await app.request(`/api/v1/alerts/${alertId}/audio/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(completeBody()),
    });
    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toEqual(bodies[0]);
    expect(notifications.calls).toHaveLength(1);
    expect(h.db.all("SELECT * FROM share_links")).toHaveLength(1);
  });

  it("never duplicates an ambiguous provider send on retries or API restart", async () => {
    await upload();
    vi.spyOn(notifications, "sendRecordingNotification").mockRejectedValue(
      new Error("Connection lost after send"),
    );
    expect((await complete()).status).toBe(503);
    expect((await complete()).status).toBe(503);
    const app = createApp(h.container);
    const response = await app.request(`/api/v1/alerts/${alertId}/audio/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(completeBody()),
    });
    expect(response.status).toBe(503);
    expect(notifications.sendRecordingNotification).toHaveBeenCalledTimes(1);
    expect(
      h.db.get<{ status: string }>("SELECT status FROM recordings WHERE id = ?", recordingId)
        ?.status,
    ).toBe("completed");
  });

  it("reports notification failure without claiming audio delivery", async () => {
    notifications.status = "failed";
    await upload();
    const response = await complete();
    expect(
      CompleteAudioResponseSchema.parse(await response.json()).notification.acceptedCount,
    ).toBe(0);
    expect(h.container.events.list(alertId).at(-1)?.type).toBe("recording.failed");
    await complete();
    expect(notifications.calls).toHaveLength(1);
  });

  it("reconciles a queued recording notification from Agent 2's persisted status without resending", async () => {
    notifications.status = "queued";
    await upload();
    expect((await complete()).status).toBe(503);
    const contactId = notifications.recipients[0]!.contactId;
    h.db.run(
      `INSERT INTO alert_notifications (id, alert_id, contact_id, contact_display_name, contact_phone_number, kind, status, created_at, updated_at)
      VALUES (?, ?, ?, 'Test contact', '+14155550123', 'recording_link', 'delivered', ?, ?)`,
      randomUUID(),
      alertId,
      contactId,
      h.clock.now(),
      h.clock.now(),
    );
    const response = await complete();
    expect(response.status).toBe(200);
    expect(
      CompleteAudioResponseSchema.parse(await response.json()).notification.acceptedCount,
    ).toBe(1);
    expect(notifications.calls).toHaveLength(1);
    expect(h.container.events.list(alertId).at(-1)?.type).toBe("recording.notification_accepted");
  });

  it("cleans expired orphan audio without touching unrelated files", () => {
    const orphan = path.join(directory, randomUUID());
    const unrelated = path.join(directory, "operator-notes.txt");
    writeFileSync(orphan, pcm);
    writeFileSync(unrelated, "keep");
    const expired = new Date(h.clock.now() - RECORDING_SHARE_LINK_TTL_MS - 1);
    utimesSync(orphan, expired, expired);
    utimesSync(unrelated, expired, expired);
    cleanupExpiredRecordings(h.container);
    expect(readdirSync(directory)).toEqual(["operator-notes.txt"]);
  });

  it("issues high-entropy links, stores only their hashes, expires and revokes them", async () => {
    await upload();
    await complete();
    const url = sharePath();
    const token = url.split("/").at(-1)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const link = h.db.get<{ token_hash: string }>("SELECT * FROM share_links")!;
    expect(link.token_hash).toBe(sha(new TextEncoder().encode(token)));
    expect(JSON.stringify(link)).not.toContain(token);
    const receipts = readdirSync(path.join(directory, ".notification-receipts"));
    expect(
      readFileSync(path.join(directory, ".notification-receipts", receipts[0]!), "utf8"),
    ).not.toContain(token);
    expect((await h.request("/r/" + "a".repeat(43))).status).toBe(404);
    h.db.run("UPDATE share_links SET revoked_at = ?", h.clock.now());
    expect((await h.request(url)).status).toBe(404);
    h.db.run("UPDATE share_links SET revoked_at = NULL");
    h.clock.advance(RECORDING_SHARE_LINK_TTL_MS);
    expect((await h.request(url)).status).toBe(404);
    expect(h.db.all("SELECT * FROM recording_chunks")).toHaveLength(0);
    expect(readdirSync(directory).filter((f) => !f.startsWith("."))).toHaveLength(0);
  });

  it("provides range and HEAD responses needed by mobile audio players", async () => {
    await upload();
    await complete();
    const url = sharePath();
    const range = await h.request(url, { headers: { Range: "bytes=44-47" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 44-47/3244");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(pcm.slice(0, 4));
    const suffix = await h.request(url, { headers: { Range: "bytes=-4" } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(pcm.slice(-4));
    expect((await h.request(url, { headers: { Range: "bytes=999999-" } })).status).toBe(416);
    const head = await h.request(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("3244");
    expect(await head.text()).toBe("");
  });

  it("fails safely on missing, corrupted and symlinked audio files", async () => {
    await upload();
    const chunk = h.db.get<{ storage_path: string }>("SELECT storage_path FROM recording_chunks")!;
    writeFileSync(chunk.storage_path, new Uint8Array(3200));
    expect((await complete()).status).toBe(503);
    expect(notifications.calls).toHaveLength(0);
    writeFileSync(chunk.storage_path, pcm);
    await complete();
    const row = h.db.get<{ storage_path: string }>("SELECT storage_path FROM recordings")!;
    rmSync(row.storage_path);
    symlinkSync(chunk.storage_path, row.storage_path);
    expect((await h.request(sharePath())).status).toBe(404);
  });

  it("handles disk failure without marking a chunk stored", async () => {
    const blocked = path.join(directory, "blocked");
    writeFileSync(blocked, "file");
    const recordings = createRecordingStorage({
      ...h.container,
      config: { ...h.container.config, audioStoragePath: path.join(blocked, "audio") },
    });
    await expect(
      recordings.storeChunk({ alertId, recordingId, index: 0, sha256: sha(pcm), bytes: pcm }),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.db.all("SELECT * FROM recording_chunks")).toHaveLength(0);
  });
});
