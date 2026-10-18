// Owner: Agent 4. Route wiring created by the foundation commit; storage lives in
// ../audio. Keep request/response shapes identical to docs/API_CONTRACTS.md.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AlertIdSchema,
  CompleteAudioRequestSchema,
  CompleteAudioResponseSchema,
  AUDIO_CHUNK_CONTENT_TYPE,
  MAX_AUDIO_CHUNK_BYTES,
  ROUTES,
  UploadAudioChunkQuerySchema,
  UploadAudioChunkResponseSchema,
} from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { createAudioCompletion } from "../audio/completion";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { readJson, readParam, readQuery, type AppEnv } from "../lib/hono";

export function createAudioRoutes(container: ServiceContainer) {
  const routes = new Hono<AppEnv>();
  const complete = createAudioCompletion(container);
  function requireOwner(alertId: string, sessionId: string) {
    const row = container.db.get<{ session_id: string | null }>(
      "SELECT session_id FROM alerts WHERE id = ?",
      alertId,
    );
    if (!row || row.session_id !== sessionId) throw notFound("Alert not found");
  }

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
      requireOwner(alertId, c.get("session").sessionId);
      if (
        c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        AUDIO_CHUNK_CONTENT_TYPE
      ) {
        throw badRequest("Audio chunks require application/octet-stream");
      }
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
    const alertId = readParam(c, "alertId", AlertIdSchema);
    requireOwner(alertId, c.get("session").sessionId);
    const input = await readJson(c, CompleteAudioRequestSchema);
    return c.json(CompleteAudioResponseSchema.parse(await complete(alertId, input)));
  });

  // Public capability URL sent to contacts. No session: the unguessable token is the credential.
  // CONTRACT-PROPOSAL(#2): foundation app.test.ts must expect 404 rather than placeholder 501.
  routes.get(ROUTES.recordingShare, async (c) => {
    const token = c.req.param("token");
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw notFound("Recording not found");
    const recording = await container.recordings.openSharedRecording(token);
    if (!recording) throw notFound("Recording not found or link expired");
    const headers = {
      "Content-Type": recording.mimeType,
      "Content-Length": String(recording.byteLength),
      "Content-Disposition": `inline; filename="${recording.filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Accept-Ranges": "bytes",
    };
    const range = c.req.header("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const size = recording.byteLength;
      const suffix = match && !match[1] ? Number(match[2]) : 0;
      const start = match?.[1] ? Number(match[1]) : Math.max(0, size - suffix);
      const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      if (
        !match ||
        (!match[1] && !match[2]) ||
        (!match[1] && suffix <= 0) ||
        !Number.isSafeInteger(start) ||
        start >= size ||
        start > end
      ) {
        return c.body(null, 416, {
          ...headers,
          "Content-Length": "0",
          "Content-Range": `bytes */${size}`,
        });
      }
      const body = recording.body.slice(start, end + 1);
      return c.body(body as Uint8Array<ArrayBuffer>, 206, {
        ...headers,
        "Content-Length": String(body.length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      });
    }
    return c.body(recording.body as Uint8Array<ArrayBuffer>, 200, headers);
  });

  return routes;
}
