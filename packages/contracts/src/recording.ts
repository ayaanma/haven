import { z } from "zod";
import { AlertIdSchema, Sha256HexSchema, TimestampMsSchema } from "./common";

/**
 * Client-generated recording ID (UUID). The G2 app mints it when capture starts so
 * chunk uploads can begin, and be retried, before the server knows the recording.
 */
export const RecordingIdSchema = z.uuid();
export type RecordingId = z.infer<typeof RecordingIdSchema>;

/**
 * PCM format produced by the G2 microphone through the Even Hub SDK `audioEvent`
 * (verified in SDK 0.0.16 docs: 16 kHz, signed 16-bit little-endian, mono).
 * The simulator emits 100 ms (3,200 bytes) per event.
 */
export const G2_PCM_FORMAT = {
  sampleRateHz: 16_000,
  bitsPerSample: 16,
  channels: 1,
  encoding: "pcm_s16le",
} as const;
export const G2_PCM_BYTES_PER_SECOND =
  (G2_PCM_FORMAT.sampleRateHz * G2_PCM_FORMAT.bitsPerSample * G2_PCM_FORMAT.channels) / 8;

/** Chunks are raw PCM bytes in G2_PCM_FORMAT, uploaded as this content type. */
export const AUDIO_CHUNK_CONTENT_TYPE = "application/octet-stream";
/** The finalized recording served to contacts. */
export const FINAL_RECORDING_MIME_TYPE = "audio/wav";

export const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
export const MAX_AUDIO_CHUNKS = 1_000;
export const MAX_RECORDING_DURATION_MS = 10 * 60_000;
/** Secure recording links sent to contacts expire after this long. */
export const RECORDING_SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

export const AudioRecordingStatusSchema = z.enum([
  /** At least one chunk stored; more may follow. */
  "receiving",
  /** `complete` was called; the server is assembling the file. */
  "finalizing",
  /** File assembled and stored. */
  "completed",
  "failed",
]);
export type AudioRecordingStatus = z.infer<typeof AudioRecordingStatusSchema>;

export const AudioRecordingMetadataSchema = z.object({
  alertId: AlertIdSchema,
  recordingId: RecordingIdSchema,
  mimeType: z.string().min(1).max(100),
  durationMs: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative().max(MAX_AUDIO_CHUNKS),
  byteLength: z.number().int().nonnegative(),
  status: AudioRecordingStatusSchema,
  createdAt: TimestampMsSchema,
  completedAt: TimestampMsSchema.nullable(),
});
export type AudioRecordingMetadata = z.infer<typeof AudioRecordingMetadataSchema>;

/**
 * Query string of `POST /api/v1/alerts/:alertId/audio/chunks`. The body is the raw chunk.
 * Retry-safe: re-sending the same (recordingId, index, sha256) returns `duplicate`;
 * the same index with a different sha256 is a 409 conflict.
 */
export const UploadAudioChunkQuerySchema = z.strictObject({
  recordingId: RecordingIdSchema,
  index: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(MAX_AUDIO_CHUNKS - 1),
  sha256: Sha256HexSchema,
});
export type UploadAudioChunkQuery = z.infer<typeof UploadAudioChunkQuerySchema>;

export const UploadAudioChunkResponseSchema = z.object({
  recordingId: RecordingIdSchema,
  index: z.number().int().nonnegative(),
  status: z.enum(["stored", "duplicate"]),
  receivedChunkCount: z.number().int().nonnegative(),
});
export type UploadAudioChunkResponse = z.infer<typeof UploadAudioChunkResponseSchema>;

/** Body of `POST /api/v1/alerts/:alertId/audio/complete`. Idempotent per recordingId. */
export const CompleteAudioRequestSchema = z.strictObject({
  recordingId: RecordingIdSchema,
  /** Chunks 0..chunkCount-1 must all be stored before completion succeeds. */
  chunkCount: z.number().int().positive().max(MAX_AUDIO_CHUNKS),
  durationMs: z.number().int().positive().max(MAX_RECORDING_DURATION_MS),
  startedAt: TimestampMsSchema,
});
export type CompleteAudioRequest = z.infer<typeof CompleteAudioRequestSchema>;

export const CompleteAudioResponseSchema = z.object({
  recording: AudioRecordingMetadataSchema,
  notification: z.object({
    /** Contacts whose recording-link message Photon accepted (not proof of delivery). */
    acceptedCount: z.number().int().nonnegative(),
    totalRecipients: z.number().int().nonnegative(),
  }),
});
export type CompleteAudioResponse = z.infer<typeof CompleteAudioResponseSchema>;
