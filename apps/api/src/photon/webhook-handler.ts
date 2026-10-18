// POST /api/v1/photon/webhooks: verified Photon events → Haven state.
//
// 1. Verify the signature (signature.ts) before reading the body; failures are 401.
// 2. Dedupe by Photon event ID (`webhook_receipts`) and by message ID (`inbound_messages`)
//    inside one transaction, so at-least-once redelivery never doubles an effect and a
//    failed processing attempt leaves no receipt (Photon may redeliver it).
// 3. message.dispatched/accepted/delivered/failed update the matching notification row
//    (never backwards) and append `notification.*` events.
// 4. message.received:
//    - unknown sender → quarantined in `inbound_messages` (no contact), ignored;
//    - STOP-type keyword → consent `revoked`; Haven never messages them again;
//    - first message from a `pending` contact → consent `verified` (the opt-in);
//    - a verified contact's message while one of their alerts is active → `contact.responded`
//      with the original text (only sanitized and length-limited). Nothing is generated.
import {
  isAcceptedNotificationStatus,
  type NotificationStatus,
  type ContactConsentStatus,
} from "@haven/contracts";
import { settleInitialNotification } from "../alerts/lifecycle";
import { applyNotificationStatus, findNotificationByPhotonMessageId } from "../alerts/store";
import { normalizePhoneHandle } from "../contacts/phone";
import {
  cachePhotonIdentity,
  findContactByPhone,
  findContactByPhotonSpace,
  setContactConsent,
  type ContactRow,
} from "../contacts/repository";
import { badRequest, unauthorized } from "../lib/errors";
import type { PhotonWebhookHandler, PhotonWebhookResult, ServiceContext } from "../lib/interfaces";
import { MOCK_WEBHOOK_SECRET } from "./mock-webhook";
import { WebhookSignatureError, verifyWebhookSignature } from "./signature";
import {
  PhotonMessageSchema,
  PhotonWebhookEventSchema,
  messageText,
  parseTimestamp,
  type PhotonMessage,
  type PhotonWebhookEvent,
} from "./webhook-events";

/** A reply maps to the contact's most recent alert created within this window. */
export const ACTIVE_ALERT_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_REPLY_LENGTH = 500;

// Whole-message keywords. CANCEL and END are deliberately absent: during an emergency
// they are ambiguous replies, not clear requests to stop all future alerts.
const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "OPTOUT", "OPT OUT", "QUIT"]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP", "OPTIN", "OPT IN"]);

const STATUS_EVENTS: Record<string, NotificationStatus> = {
  "message.dispatched": "photon_accepted",
  "message.accepted": "delivery_unconfirmed",
  "message.delivered": "delivered",
  "message.failed": "failed",
};

type Outcome = PhotonWebhookResult["status"];

export interface PhotonWebhookHandlerOptions {
  /** Accepted signing secrets (default: from config; mock mode adds MOCK_WEBHOOK_SECRET). */
  secrets?: readonly string[];
}

export function webhookSecrets(ctx: ServiceContext): string[] {
  const configured = ctx.config.photon.webhookSecret;
  if (ctx.config.photon.mode === "live") return configured ? [configured] : [];
  return configured ? [configured, MOCK_WEBHOOK_SECRET] : [MOCK_WEBHOOK_SECRET];
}

export function createWebhookHandler(
  ctx: ServiceContext,
  options: PhotonWebhookHandlerOptions = {},
): PhotonWebhookHandler {
  const { db, config } = ctx;
  const secrets = options.secrets ?? webhookSecrets(ctx);
  const log = ctx.logger.child({ module: "photon-webhooks", photonMode: config.photon.mode });

  function keyword(text: string | null): "opt_out" | "opt_in" | null {
    const word = (text ?? "")
      .trim()
      .toUpperCase()
      .replace(/[.!]+$/, "");
    if (OPT_OUT_KEYWORDS.has(word)) return "opt_out";
    if (OPT_IN_KEYWORDS.has(word)) return "opt_in";
    return null;
  }

  function changeConsent(contact: ContactRow, status: ContactConsentStatus, eventId: string) {
    if (setContactConsent(db, contact.id, status, ctx.clock.now())) {
      log.info("contact consent changed", { contactId: contact.id, consent: status, eventId });
    }
  }

  function activeAlertFor(
    contactId: string,
    parentMessageId: string | undefined,
  ): { alertId: string; displayName: string } | null {
    if (parentMessageId) {
      const parent = findNotificationByPhotonMessageId(db, parentMessageId);
      if (
        parent &&
        parent.contact_id === contactId &&
        isAcceptedNotificationStatus(parent.status)
      ) {
        return { alertId: parent.alert_id, displayName: parent.contact_display_name };
      }
    }
    const row = db.get<{ alert_id: string; contact_display_name: string }>(
      `SELECT n.alert_id, n.contact_display_name
       FROM alert_notifications n JOIN alerts a ON a.id = n.alert_id
       WHERE n.contact_id = ? AND n.kind = 'initial_sos'
         AND n.status IN ('photon_accepted', 'delivery_unconfirmed', 'delivered')
         AND a.created_at >= ?
       ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
      contactId,
      ctx.clock.now() - ACTIVE_ALERT_WINDOW_MS,
    );
    return row ? { alertId: row.alert_id, displayName: row.contact_display_name } : null;
  }

  function received(event: PhotonWebhookEvent, message: PhotonMessage): Outcome {
    if (message.status !== undefined && message.status !== "received") return "ignored";
    const agentUserId = config.photon.agentUserId;
    if (agentUserId && message.sentBy?.id === agentUserId) return "ignored";

    const handle = message.sentBy?.handle ?? "";
    const phone = normalizePhoneHandle(handle);
    const spaceId = message.space?.id;
    const bySpace = spaceId ? findContactByPhotonSpace(db, spaceId) : undefined;
    const contact = bySpace ?? (phone ? findContactByPhone(db, phone) : undefined);
    const text = messageText(message.content);
    const now = ctx.clock.now();
    const receivedAt =
      parseTimestamp(message.timestamps?.receivedAt) ?? parseTimestamp(event.timestamp) ?? now;

    const replyTo =
      contact?.consent_status === "verified" && keyword(text) === null
        ? activeAlertFor(contact.id, message.parentMessageId)
        : null;
    const stored = db.run(
      `INSERT INTO inbound_messages (photon_message_id, contact_id, alert_id, sender_handle, text,
         received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (photon_message_id) DO NOTHING`,
      message.id,
      contact?.id ?? null,
      replyTo?.alertId ?? null,
      handle.slice(0, 320),
      text,
      receivedAt,
      now,
    );
    if (stored.changes === 0) return "duplicate";

    if (!contact) {
      log.info("message from unknown sender quarantined", { eventId: event.id });
      return "ignored";
    }

    // Remember who this contact is on Photon and which line they texted: the direct Space,
    // their User, and the line's agent (on shared lines it differs per contact).
    const senderId = message.sentBy?.id;
    const participants = message.space?.participantIds ?? [];
    const others = participants.filter((id) => id !== senderId);
    const lineAgent =
      message.receivedBy?.id ??
      (participants.length === 2 && others.length === 1 ? others[0] : null);
    if (
      spaceId &&
      senderId &&
      lineAgent &&
      (contact.photon_space_id !== spaceId ||
        contact.photon_user_id !== senderId ||
        contact.photon_agent_user_id !== lineAgent)
    ) {
      cachePhotonIdentity(db, contact.id, contact.phone_number, {
        userId: senderId,
        spaceId,
        agentUserId: lineAgent,
      });
    }

    const command = keyword(text);
    if (command === "opt_out") {
      changeConsent(contact, "revoked", event.id);
      return "processed";
    }
    if (contact.consent_status === "revoked") {
      if (command !== "opt_in") return "ignored";
      changeConsent(contact, "verified", event.id);
      return "processed";
    }
    if (contact.consent_status === "pending") {
      changeConsent(contact, "verified", event.id);
      return "processed";
    }

    const reply = sanitizeReply(text);
    if (!replyTo || reply === null) return "ignored";
    ctx.events.append(replyTo.alertId, {
      type: "contact.responded",
      payload: {
        contactId: contact.id,
        displayName: replyTo.displayName,
        text: reply,
        receivedAt,
      },
    });
    log.info("contact reply recorded", { alertId: replyTo.alertId, contactId: contact.id });
    return "processed";
  }

  function statusUpdate(type: string, message: PhotonMessage): Outcome {
    const row = findNotificationByPhotonMessageId(db, message.id);
    const status = STATUS_EVENTS[type];
    if (!row || !status) return "ignored";
    const changed = applyNotificationStatus(ctx, row.id, {
      status,
      failureCode: message.failure?.code ?? "message_failed",
    });
    if (changed && row.kind === "initial_sos") settleInitialNotification(ctx, row.alert_id);
    return "processed";
  }

  function process(event: PhotonWebhookEvent): Outcome {
    const projectId = event.data.projectId;
    if (config.photon.projectId && projectId && projectId !== config.photon.projectId) {
      return "ignored";
    }
    const message = PhotonMessageSchema.safeParse(event.data.object);
    if (!message.success) return "ignored";
    if (event.type === "message.received") return received(event, message.data);
    if (event.type in STATUS_EVENTS) return statusUpdate(event.type, message.data);
    return "ignored";
  }

  return {
    async handle(request) {
      if (secrets.length === 0) {
        log.error("webhook signing secret is not configured");
        throw unauthorized("Webhook signing is not configured");
      }
      try {
        verifyWebhookSignature({
          secrets,
          headers: request.headers,
          rawBody: request.rawBody,
          nowMs: ctx.clock.now(),
        });
      } catch (error) {
        if (!(error instanceof WebhookSignatureError)) throw error;
        // Header names only (never values) so a different real scheme is easy to diagnose.
        const signatureHeaders = Object.keys(request.headers).filter((name) =>
          /sign|webhook|svix|photon|timestamp/.test(name),
        );
        log.warn("webhook rejected", { reason: error.reason, signatureHeaders });
        throw unauthorized("Invalid webhook signature");
      }

      let json: unknown;
      try {
        json = JSON.parse(request.rawBody);
      } catch {
        throw badRequest("Webhook body must be JSON");
      }
      const parsed = PhotonWebhookEventSchema.safeParse(json);
      if (!parsed.success) throw badRequest("Unrecognized webhook event");
      const event = parsed.data;

      const status = db.transaction((): Outcome => {
        const receipt = db.run(
          `INSERT INTO webhook_receipts (event_id, event_type, received_at) VALUES (?, ?, ?)
           ON CONFLICT (event_id) DO NOTHING`,
          event.id,
          event.type,
          ctx.clock.now(),
        );
        return receipt.changes === 0 ? "duplicate" : process(event);
      });
      log.info("webhook handled", { eventId: event.id, eventType: event.type, status });
      return { status };
    },
  };
}

/** Original reply text, minus control characters, at most MAX_REPLY_LENGTH characters. */
export function sanitizeReply(text: string | null): string | null {
  if (text === null) return null;
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length === 0) return null;
  if (clean.length <= MAX_REPLY_LENGTH) return clean;
  let out = "";
  for (const char of clean) {
    if (out.length + char.length > MAX_REPLY_LENGTH - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}
