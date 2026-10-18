// PHOTON_MODE=live: Photon 2.0 Beta (https://api.photon.codes/v1) through the official
// @photon-ai/api client (pinned 0.5.0). Not the Stable/Spectrum API.
//
// Per contact (verified against the Photon OpenAPI contract, 2026-10-18):
//   POST /v1/projects/{id}/users     createOrGetUser  { handle, platform }       → pho_usr_
//   POST /v1/projects/{id}/spaces    createOrGetSpace { participantIds, platform }
//        Idempotency-Key required; iMessage uses the first participant (Haven's line) as
//        creator, and direct Spaces converge by participants                      → pho_spc_
//   POST /v1/projects/{id}/messages  sendMessage { spaceId, senderId, content }
//        Idempotency-Key required; 202 = persisted for asynchronous delivery      → pho_msg_
// Auth: `Authorization: Bearer pho_sk_...` (a project API key, server-side only).
//
// The client is imported lazily, so mock mode never loads it, and it can never be built
// unless PHOTON_MODE=live.
import type { Photon } from "@photon-ai/api";
import type { HavenConfig } from "../lib/config";
import { classifyPhotonError, isNamedError } from "./errors";
import type { PhotonTransport, ProviderMessageStatus, SendOutcome } from "./transport";

export interface LivePhotonTransportOptions {
  /** Replaces global fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Per HTTP attempt. The client retries 408/429/502/503/504 and network errors itself. */
  timeoutMs?: number;
  /** HTTP attempts per call, 1–3 (the client's own retry, only for idempotent requests). */
  maxAttempts?: number;
  baseUrl?: string;
}

const PROVIDER_STATUSES: readonly ProviderMessageStatus[] = [
  "dispatched",
  "accepted",
  "delivered",
  "failed",
];

class PhotonShapeError extends Error {
  constructor(what: string) {
    super(`Photon response is missing ${what}`);
    this.name = "ResponseValidationError";
  }
}

function idOf(resource: unknown, what: string): string {
  const id = (resource as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0) throw new PhotonShapeError(`${what}.id`);
  return id;
}

export function createLivePhotonTransport(
  config: HavenConfig,
  options: LivePhotonTransportOptions = {},
): PhotonTransport {
  const { mode, apiKey, projectId, agentUserId, platform } = config.photon;
  if (mode !== "live") {
    throw new Error("The live Photon transport requires PHOTON_MODE=live");
  }
  if (!apiKey || !projectId || !agentUserId) {
    throw new Error(
      "PHOTON_MODE=live needs PHOTON_API_KEY, PHOTON_PROJECT_ID, PHOTON_AGENT_USER_ID",
    );
  }

  let client: Promise<Photon> | null = null;
  const photon = (): Promise<Photon> => {
    client ??= import("@photon-ai/api")
      .then(
        ({ Photon: PhotonClient }) =>
          new PhotonClient({
            headers: { Authorization: `Bearer ${apiKey}` },
            timeoutMs: options.timeoutMs ?? 10_000,
            retry: { maxAttempts: options.maxAttempts ?? 3 },
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
      )
      .catch((error: unknown) => {
        client = null;
        throw error;
      });
    return client;
  };

  return {
    mode: "live",
    async send(message): Promise<SendOutcome> {
      let userId = message.recipient.userId;
      let spaceId = message.recipient.spaceId;
      try {
        const api = await photon();
        if (!userId) {
          const user = await api.projects.createOrGetUser({
            path: { id: projectId },
            body: { handle: message.recipient.phoneNumber, platform },
          });
          userId = idOf(user, "user");
        }
        if (!spaceId) {
          const space = await api.projects.createOrGetSpace({
            path: { id: projectId },
            body: { participantIds: [agentUserId, userId], platform },
            headers: { "idempotency-key": `haven-space:${agentUserId}:${userId}` },
          });
          spaceId = idOf(space, "space");
        }
        const response = await api.raw.projects.sendMessage({
          path: { id: projectId },
          body: {
            spaceId,
            senderId: agentUserId,
            content: { type: "text", format: "plain", text: message.text },
          },
          headers: { "idempotency-key": message.idempotencyKey },
        });
        const sent = response.data as { status?: unknown; failure?: { code?: unknown } };
        const status = PROVIDER_STATUSES.find((s) => s === sent.status) ?? "dispatched";
        const failureCode = typeof sent.failure?.code === "string" ? sent.failure.code : null;
        return {
          ok: true,
          providerMessageId: idOf(response.data, "message"),
          providerStatus: status,
          failureCode,
          replayed: response.headers.get("idempotent-replayed") === "true",
          identity: { userId, spaceId },
        };
      } catch (error) {
        // A 202 whose body the pinned client cannot decode still means Photon persisted the
        // message. Report the acceptance; delivery webhooks cannot be matched without the ID.
        if (
          isNamedError(error, "ResponseValidationError") &&
          error.operationId === "sendMessage" &&
          error.status === 202
        ) {
          return {
            ok: true,
            providerMessageId: null,
            providerStatus: "dispatched",
            failureCode: null,
            replayed: false,
            identity: { userId, spaceId },
          };
        }
        const classified = classifyPhotonError(error);
        if (classified.resetIdentity === "user") userId = null;
        if (classified.resetIdentity) spaceId = null;
        return {
          ok: false,
          retryable: classified.retryable,
          failureCode: classified.failureCode,
          identity: { userId, spaceId },
        };
      }
    },
  };
}
