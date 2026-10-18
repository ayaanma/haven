// Owner: Agent 4. Route wiring created by the foundation commit; storage lives in
// ../audio. Keep request/response shapes identical to docs/API_CONTRACTS.md.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AlertIdSchema,
  CompleteAudioRequestSchema,
  MAX_AUDIO_CHUNK_BYTES,
  ROUTES,
  UploadAudioChunkQuerySchema,
  UploadAudioChunkResponseSchema,
} from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { HttpError, NotImplementedError, badRequest, notFound } from "../lib/errors";
import { readJson, readParam, readQuery, type AppEnv } from "../lib/hono";

export function createAudioRoutes(container: ServiceContainer) {
  const routes = new Hono<AppEnv>();

  routes.post(
    ROUTES.audioChunks,
    container.auth.require("audio:write"),
    bodyLimit({
      maxSize: MAX_AUDIO_CHUNK_BYTES,
      onError: () => {
        throw new HttpError(413, "payload_too_large", "Audio chunk exceeds MAX_AUDIO_CHUNK_BYTES");
      },
    }),
    async (c) => {
      const alertId = readParam(c, "alertId", AlertIdSchema);
      const query = readQuery(c, UploadAudioChunkQuerySchema);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) throw badRequest("Audio chunk body is empty");
      const result = await container.recordings.storeChunk({ alertId, ...query, bytes });
      return c.json(
        UploadAudioChunkResponseSchema.parse({
          recordingId: query.recordingId,
          index: query.index,
          ...result,
        }),
        result.status === "stored" ? 201 : 200,
      );
    },
  );

  routes.post(ROUTES.audioComplete, container.auth.require("audio:write"), async (c) => {
    readParam(c, "alertId", AlertIdSchema);
    await readJson(c, CompleteAudioRequestSchema);
    // Agent 4: finalizeRecording → createSecureShareLink → notifications.sendRecordingNotification,
    // append recording.* events, and respond with CompleteAudioResponseSchema.parse(...).
    // Must be idempotent per recordingId (never re-notify contacts on a retry).
    throw new NotImplementedError("audio completion (Agent 4)");
  });

  // Public capability URL sent to contacts. No session: the unguessable token is the credential.
  routes.get(ROUTES.recordingShare, async (c) => {
    const token = c.req.param("token");
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw notFound("Recording not found");
    const recording = await container.recordings.openSharedRecording(token);
    if (!recording) throw notFound("Recording not found or link expired");
    return c.body(recording.body as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": recording.mimeType,
      "Content-Length": String(recording.byteLength),
      "Content-Disposition": `inline; filename="${recording.filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    });
  });

  return routes;
}
