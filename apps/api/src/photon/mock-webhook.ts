// Mock-mode webhook support: build Photon-shaped events and sign them the way the handler
// verifies them. PHOTON_MODE=mock accepts MOCK_WEBHOOK_SECRET so a contact's opt-in and
// replies can be simulated locally (see simulate-reply.ts). Live mode never accepts it.
import { randomBytes } from "node:crypto";
import { signWebhook } from "./signature";
import type { PhotonWebhookEvent } from "./webhook-events";

export const MOCK_WEBHOOK_SECRET = `whsec_${Buffer.from(
  "haven-mock-webhook-secret-never-valid-in-live-mode",
).toString("base64")}`;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A random ID in Photon's format, e.g. `pho_evt_01k…` (26 lowercase base32 characters). */
export function photonStyleId(kind: "evt" | "msg" | "usr" | "spc" | "prj"): string {
  const bytes = randomBytes(26);
  let body = ALPHABET[(bytes[0] ?? 0) % 8] ?? "0";
  for (let i = 1; i < 26; i++) body += ALPHABET[(bytes[i] ?? 0) % 32];
  return `pho_${kind}_${body}`;
}

export interface MockReceivedMessageInput {
  fromHandle: string;
  text: string;
  atMs: number;
  projectId?: string;
  platform?: string;
  messageId?: string;
  eventId?: string;
  senderUserId?: string;
  spaceId?: string;
  agentUserId?: string;
  parentMessageId?: string;
}

export function buildMessageReceivedEvent(input: MockReceivedMessageInput): PhotonWebhookEvent {
  const platform = input.platform ?? "imessage";
  const projectId = input.projectId ?? photonStyleId("prj");
  const senderUserId = input.senderUserId ?? photonStyleId("usr");
  const at = new Date(input.atMs).toISOString();
  return {
    id: input.eventId ?? photonStyleId("evt"),
    type: "message.received",
    apiVersion: "2026-07-01",
    source: `${platform}.photon`,
    timestamp: at,
    data: {
      projectId,
      object: {
        id: input.messageId ?? photonStyleId("msg"),
        status: "received",
        platform,
        projectId,
        sentBy: { id: senderUserId, handle: input.fromHandle, platform, projectId },
        space: {
          id: input.spaceId ?? photonStyleId("spc"),
          platform,
          projectId,
          participantIds: input.agentUserId ? [input.agentUserId, senderUserId] : [senderUserId],
        },
        content: { type: "text", format: "plain", text: input.text },
        ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
        timestamps: { receivedAt: at },
        createdAt: at,
        updatedAt: at,
      },
    },
  };
}

export interface MockStatusEventInput {
  type: "message.dispatched" | "message.accepted" | "message.delivered" | "message.failed";
  messageId: string;
  atMs: number;
  projectId?: string;
  failureCode?: string;
  eventId?: string;
}

export function buildMessageStatusEvent(input: MockStatusEventInput): PhotonWebhookEvent {
  const projectId = input.projectId ?? photonStyleId("prj");
  const status = input.type.slice("message.".length);
  const at = new Date(input.atMs).toISOString();
  return {
    id: input.eventId ?? photonStyleId("evt"),
    type: input.type,
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: at,
    data: {
      projectId,
      object: {
        id: input.messageId,
        status,
        platform: "imessage",
        projectId,
        ...(input.failureCode ? { failure: { code: input.failureCode, message: "failed" } } : {}),
      },
    },
  };
}

/** Raw body plus signed headers, ready to POST to the webhook route. */
export function signedWebhookRequest(
  event: PhotonWebhookEvent,
  options: { secret?: string; timestampMs: number; webhookId?: string },
): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(event);
  const headers = signWebhook(options.secret ?? MOCK_WEBHOOK_SECRET, rawBody, {
    webhookId: options.webhookId ?? `msg_${event.id}`,
    timestampMs: options.timestampMs,
  });
  return { rawBody, headers: { "content-type": "application/json", ...headers } };
}
