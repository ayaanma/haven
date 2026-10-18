// Photon 2.0 webhook event shapes, from the Photon OpenAPI contract (API version 2026-07-01).
// These describe Photon's payloads, not Haven contracts, and are parsed loosely: unknown
// fields are kept and only what Haven reads is required.
//
//   { id: "pho_evt_…", type: "message.received", apiVersion: "2026-07-01",
//     source: "imessage.photon", timestamp: "<RFC 3339>",
//     data: { projectId: "pho_prj_…", object: Message } }
//
// Message: { id: "pho_msg_…", status, platform, sentBy: { id, handle }, space: { id,
//   participantIds }, content: { type: "text", format, text } | { type: "group", parts },
//   parentMessageId?, timestamps: { receivedAt | dispatchedAt | … }, failure?: { code } }
import { z } from "zod";

export const PhotonWebhookEventSchema = z.looseObject({
  id: z.string().regex(/^pho_evt_[0-9a-z]{20,40}$/i),
  type: z.string().min(1).max(100),
  apiVersion: z.string().max(40).optional(),
  source: z.string().max(100).optional(),
  timestamp: z.string().max(64).optional(),
  data: z.looseObject({
    projectId: z.string().max(64).optional(),
    object: z.unknown().optional(),
  }),
});
export type PhotonWebhookEvent = z.infer<typeof PhotonWebhookEventSchema>;

export const PhotonMessageSchema = z.looseObject({
  id: z.string().min(1).max(64),
  status: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
  sentBy: z
    .looseObject({ id: z.string().max(64).optional(), handle: z.string().max(320).optional() })
    .optional(),
  /** The agent line that received an incoming message. */
  receivedBy: z.looseObject({ id: z.string().max(64).optional() }).optional(),
  space: z
    .looseObject({
      id: z.string().max(64),
      participantIds: z.array(z.string().max(64)).max(1000).optional(),
    })
    .optional(),
  content: z.unknown().optional(),
  parentMessageId: z.string().max(64).optional(),
  timestamps: z.record(z.string(), z.unknown()).optional(),
  failure: z.looseObject({ code: z.string().max(100) }).optional(),
});
export type PhotonMessage = z.infer<typeof PhotonMessageSchema>;

/** Plain text of a message: a text part, or the text parts of a group, else null. */
export function messageText(content: unknown): string | null {
  if (typeof content !== "object" || content === null) return null;
  const value = content as { type?: unknown; text?: unknown; parts?: unknown };
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "group" && Array.isArray(value.parts)) {
    const texts = value.parts.map(messageText).filter((text) => text !== null);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
