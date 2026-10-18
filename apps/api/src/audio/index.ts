import {
  constants,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import {
  AlertIdSchema,
  RecordingIdSchema,
  UploadAudioChunkQuerySchema,
  CompleteAudioRequestSchema,
  G2_PCM_BYTES_PER_SECOND,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_RECORDING_DURATION_MS,
  RECORDING_SHARE_LINK_TTL_MS,
  FINAL_RECORDING_MIME_TYPE,
  type AudioRecordingMetadata,
} from "@haven/contracts";
import { badRequest, conflict, HttpError, notFound, unavailable } from "../lib/errors";
import type { HavenRecordingStorage, ServiceContext } from "../lib/interfaces";
import { encodeWav } from "./wav";

export const MAX_RECORDING_BYTES = (G2_PCM_BYTES_PER_SECOND * MAX_RECORDING_DURATION_MS) / 1000;
type RecordingRow = Record<string, unknown> & {
  id: string;
  alert_id: string;
  status: AudioRecordingMetadata["status"];
  mime_type: string;
  chunk_count: number;
  byte_length: number;
  duration_ms: number | null;
  started_at: number | null;
  storage_path: string | null;
  sha256: string | null;
  created_at: number;
  completed_at: number | null;
};
type ChunkRow = Record<string, unknown> & {
  chunk_index: number;
  sha256: string;
  storage_path: string;
  byte_length: number;
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tooLarge = () =>
  new HttpError(413, "payload_too_large", "Recording exceeds the ten-minute PCM limit");

function metadata(row: RecordingRow): AudioRecordingMetadata {
  return {
    alertId: row.alert_id,
    recordingId: row.id,
    mimeType: row.mime_type,
    durationMs: row.duration_ms ?? 0,
    chunkCount: row.chunk_count,
    byteLength: row.byte_length,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** All audio files are private, flat, randomly named files beneath the configured root. */
function privateFiles(rootPath: string) {
  const root = path.resolve(rootPath);
  const checked = (filename: string) => {
    if (path.dirname(path.resolve(filename)) !== root)
      throw unavailable("Invalid recording storage location");
    return filename;
  };
  return {
    write(bytes: Uint8Array): string {
      const filename = path.join(root, randomUUID());
      const temporary = filename + ".tmp";
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, filename);
        return filename;
      } catch {
        try {
          rmSync(temporary, { force: true });
        } catch {
          /* Preserve the sanitized storage error. */
        }
        throw unavailable("Recording storage is unavailable");
      }
    },
    read(filename: string): Uint8Array {
      const fd = openSync(checked(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    remove(filename: string) {
      rmSync(checked(filename), { force: true });
    },
  };
}

/** Called on audio traffic and available to a deployment's scheduled maintenance job. */
export function cleanupExpiredRecordings(ctx: ServiceContext): number {
  const files = privateFiles(ctx.config.audioStoragePath);
  const expired = ctx.db.all<RecordingRow>(
    "SELECT * FROM recordings WHERE COALESCE(completed_at, created_at) <= ? AND (storage_path IS NOT NULL OR status != 'failed')",
    ctx.clock.now() - RECORDING_SHARE_LINK_TTL_MS,
  );
  for (const row of expired) {
    const chunks = ctx.db.all<ChunkRow>(
      "SELECT * FROM recording_chunks WHERE recording_id = ?",
      row.id,
    );
    // Unlink first: a filesystem failure leaves rows available for the next maintenance retry.
    for (const chunk of chunks) files.remove(chunk.storage_path);
    if (row.storage_path) files.remove(row.storage_path);
    const receipt = path.join(
      ctx.config.audioStoragePath,
      ".notification-receipts",
      hash(row.id) + ".json",
    );
    rmSync(receipt, { force: true });
    ctx.db.transaction(() => {
      ctx.db.run("DELETE FROM share_links WHERE recording_id = ?", row.id);
      ctx.db.run("DELETE FROM recording_chunks WHERE recording_id = ?", row.id);
      ctx.db.run(
        "UPDATE recordings SET storage_path = NULL, status = 'failed' WHERE id = ?",
        row.id,
      );
    });
  }
  // Recover files left behind if the process stopped between an atomic write and its DB commit.
  const referenced = new Set(
    [
      ...ctx.db.all<{ storage_path: string }>("SELECT storage_path FROM recording_chunks"),
      ...ctx.db.all<{ storage_path: string }>(
        "SELECT storage_path FROM recordings WHERE storage_path IS NOT NULL",
      ),
    ].map((row) => row.storage_path),
  );
  let names: string[];
  try {
    names = readdirSync(ctx.config.audioStoragePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return expired.length;
    throw unavailable("Recording cleanup is unavailable");
  }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}(?:\.tmp)?$/.test(name)) continue;
    const filename = path.join(ctx.config.audioStoragePath, name);
    if (
      !referenced.has(filename) &&
      lstatSync(filename).mtimeMs + RECORDING_SHARE_LINK_TTL_MS <= ctx.clock.now()
    )
      files.remove(filename);
  }
  return expired.length;
}

export function createRecordingStorage(ctx: ServiceContext): HavenRecordingStorage {
  const { db, clock, events } = ctx;
  const files = privateFiles(ctx.config.audioStoragePath);
  let lastCleanupAt = -Infinity;
  function cleanup() {
    if (clock.now() - lastCleanupAt < 60_000) return;
    cleanupExpiredRecordings(ctx);
    lastCleanupAt = clock.now();
  }
  const get = (id: string) => db.get<RecordingRow>("SELECT * FROM recordings WHERE id = ?", id);
  function validateAlert(alertId: string) {
    if (!AlertIdSchema.safeParse(alertId).success) throw badRequest("Invalid alert ID");
    const alert = db.get<{ state: string }>("SELECT state FROM alerts WHERE id = ?", alertId);
    if (!alert) throw notFound("Alert not found");
    if (
      alert.state !== "notified" &&
      !db.get(
        "SELECT id FROM alert_events WHERE alert_id = ? AND type = 'alert.initial_notification_accepted'",
        alertId,
      )
    ) {
      throw conflict("Initial SOS has not been accepted");
    }
  }
  function owned(row: RecordingRow | undefined, alertId: string): RecordingRow {
    if (!row || row.alert_id !== alertId) throw notFound("Recording not found");
    if ((row.completed_at ?? row.created_at) + RECORDING_SHARE_LINK_TTL_MS <= clock.now())
      throw notFound("Recording expired");
    return row;
  }

  return {
    async storeChunk(input) {
      cleanup();
      const query = UploadAudioChunkQuerySchema.safeParse({
        recordingId: input.recordingId,
        index: input.index,
        sha256: input.sha256,
      });
      if (!query.success) throw badRequest("Invalid chunk parameters");
      validateAlert(input.alertId);
      if (!input.bytes.length) throw badRequest("Audio chunk body is empty");
      if (input.bytes.length > MAX_AUDIO_CHUNK_BYTES) throw tooLarge();
      if (hash(input.bytes) !== input.sha256) throw badRequest("Audio chunk hash does not match");
      let row = get(input.recordingId);
      if (row) owned(row, input.alertId);
      const previous = db.get<ChunkRow>(
        "SELECT * FROM recording_chunks WHERE recording_id = ? AND chunk_index = ?",
        input.recordingId,
        input.index,
      );
      if (previous) {
        if (previous.sha256 !== input.sha256 || previous.byte_length !== input.bytes.length)
          throw conflict("Chunk index already contains different audio");
        return { status: "duplicate", receivedChunkCount: row!.chunk_count };
      }
      if (row && row.status !== "receiving") throw conflict("Recording is already finalized");
      if ((row?.byte_length ?? 0) + input.bytes.length > MAX_RECORDING_BYTES) throw tooLarge();
      if (!row && db.get("SELECT id FROM recordings WHERE alert_id = ?", input.alertId))
        throw conflict("This alert already has a recording");
      const filename = files.write(input.bytes);
      try {
        db.transaction(() => {
          if (!row) {
            db.run(
              "INSERT INTO recordings (id, alert_id, mime_type, created_at) VALUES (?, ?, ?, ?)",
              input.recordingId,
              input.alertId,
              FINAL_RECORDING_MIME_TYPE,
              clock.now(),
            );
            events.append(input.alertId, {
              type: "recording.started",
              payload: { recordingId: input.recordingId },
            });
          }
          db.run(
            "INSERT INTO recording_chunks (recording_id, chunk_index, sha256, byte_length, storage_path, received_at) VALUES (?, ?, ?, ?, ?, ?)",
            input.recordingId,
            input.index,
            input.sha256,
            input.bytes.length,
            filename,
            clock.now(),
          );
          db.run(
            "UPDATE recordings SET chunk_count = chunk_count + 1, byte_length = byte_length + ? WHERE id = ?",
            input.bytes.length,
            input.recordingId,
          );
        });
      } catch (error) {
        files.remove(filename);
        throw error;
      }
      row = get(input.recordingId)!;
      return { status: "stored", receivedChunkCount: row.chunk_count };
    },

    async finalizeRecording(input) {
      cleanup();
      if (
        !CompleteAudioRequestSchema.safeParse({
          recordingId: input.recordingId,
          chunkCount: input.chunkCount,
          durationMs: input.durationMs,
          startedAt: input.startedAt,
        }).success
      )
        throw badRequest("Invalid completion parameters");
      validateAlert(input.alertId);
      const row = owned(get(input.recordingId), input.alertId);
      if (row.status === "completed") {
        if (
          input.chunkCount !== row.chunk_count ||
          input.durationMs !== row.duration_ms ||
          input.startedAt !== row.started_at
        )
          throw conflict("Completion parameters differ from the finalized recording");
        return metadata(row);
      }
      if (row.status !== "receiving" && row.status !== "finalizing")
        throw conflict("Recording cannot be finalized");
      const chunks = db.all<ChunkRow>(
        "SELECT * FROM recording_chunks WHERE recording_id = ? ORDER BY chunk_index",
        input.recordingId,
      );
      const missing = Array.from({ length: input.chunkCount }, (_, i) => i).filter(
        (i) => !chunks.some((c) => c.chunk_index === i),
      );
      if (missing.length) throw conflict(`Missing audio chunks: ${missing.join(", ")}`);
      if (chunks.length !== input.chunkCount) throw conflict("Unexpected audio chunks");
      const length = chunks.reduce((n, c) => n + c.byte_length, 0);
      if (length > MAX_RECORDING_BYTES) throw tooLarge();
      if (length % 2) throw badRequest("PCM must contain complete 16-bit samples");
      const durationMs = Math.max(1, Math.round((length * 1000) / G2_PCM_BYTES_PER_SECOND));
      if (input.durationMs !== durationMs)
        throw badRequest("Duration does not match the captured PCM samples");
      if (row.started_at !== null && row.started_at !== input.startedAt)
        throw conflict("Completion start time differs from the recording");
      db.run(
        "UPDATE recordings SET status = 'finalizing', started_at = ?, duration_ms = ? WHERE id = ?",
        input.startedAt,
        durationMs,
        input.recordingId,
      );
      const pcm = new Uint8Array(length);
      let offset = 0;
      try {
        for (const chunk of chunks) {
          const bytes = files.read(chunk.storage_path);
          if (bytes.length !== chunk.byte_length || hash(bytes) !== chunk.sha256)
            throw new Error("corrupt chunk");
          pcm.set(bytes, offset);
          offset += bytes.length;
        }
      } catch {
        throw unavailable("Stored recording chunks could not be read");
      }
      const wav = encodeWav(pcm);
      const filename = files.write(wav);
      try {
        db.transaction(() => {
          db.run(
            "UPDATE recordings SET status = 'completed', storage_path = ?, byte_length = ?, duration_ms = ?, started_at = ?, sha256 = ?, completed_at = ? WHERE id = ?",
            filename,
            wav.length,
            durationMs,
            input.startedAt,
            hash(wav),
            clock.now(),
            input.recordingId,
          );
          events.append(input.alertId, {
            type: "recording.upload_completed",
            payload: {
              recordingId: input.recordingId,
              durationMs,
              chunkCount: input.chunkCount,
              byteLength: wav.length,
            },
          });
        });
      } catch (error) {
        files.remove(filename);
        throw error;
      }
      return metadata(get(input.recordingId)!);
    },

    async createSecureShareLink(input) {
      if (!RecordingIdSchema.safeParse(input.recordingId).success)
        throw badRequest("Invalid recording ID");
      const row = owned(get(input.recordingId), input.alertId);
      if (row.status !== "completed" || !row.storage_path)
        throw conflict("Recording is not finalized");
      const ttl = input.ttlMs ?? RECORDING_SHARE_LINK_TTL_MS;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > RECORDING_SHARE_LINK_TTL_MS)
        throw badRequest("Invalid recording link lifetime");
      if (ctx.config.photon.mode === "live" && !ctx.config.publicBaseUrl.startsWith("https://"))
        throw unavailable("Public recording links require HTTPS");
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Math.min(
        clock.now() + ttl,
        row.completed_at! + RECORDING_SHARE_LINK_TTL_MS,
      );
      db.run(
        "INSERT INTO share_links (token_hash, recording_id, alert_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        hash(token),
        input.recordingId,
        input.alertId,
        clock.now(),
        expiresAt,
      );
      return { url: `${ctx.config.publicBaseUrl}/r/${token}`, expiresAt };
    },

    async openSharedRecording(token) {
      cleanup();
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
      const link = db.get<{ recording_id: string; alert_id: string }>(
        "SELECT recording_id, alert_id FROM share_links WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
        hash(token),
        clock.now(),
      );
      if (!link) return null;
      const row = get(link.recording_id);
      if (!row || row.alert_id !== link.alert_id || row.status !== "completed" || !row.storage_path)
        return null;
      let body: Uint8Array;
      try {
        body = files.read(row.storage_path);
      } catch {
        return null;
      }
      if (body.length !== row.byte_length || hash(body) !== row.sha256) return null;
      db.run(
        "UPDATE share_links SET access_count = access_count + 1, last_accessed_at = ? WHERE token_hash = ?",
        clock.now(),
        hash(token),
      );
      return {
        body,
        mimeType: FINAL_RECORDING_MIME_TYPE,
        byteLength: body.length,
        filename: "haven-recording.wav",
      };
    },
  };
}
