// The seam between Haven's notification logic and Photon. Two implementations exist:
// mock-transport.ts (PHOTON_MODE=mock: writes `mock_outbox`, no network) and
// live-transport.ts (PHOTON_MODE=live: Photon 2.0 Beta through @photon-ai/api).
import type { NotificationKind } from "@haven/contracts";

export interface PhotonIdentity {
  /** Photon User ID of the contact (`pho_usr_...`). */
  userId: string | null;
  /** Photon Space ID of the direct conversation between Haven's line and the contact. */
  spaceId: string | null;
}

export interface OutboundMessage {
  /** `alert_notifications.id`. */
  notificationId: string;
  kind: NotificationKind;
  /** Stable per (alert, contact, kind): a resend after a lost response is a replay. */
  idempotencyKey: string;
  text: string;
  recipient: {
    contactId: string;
    phoneNumber: string;
    /**
     * Agent User ID of the line this contact uses (learned from their opt-in message). On
     * shared lines each contact may have a different line; falls back to PHOTON_AGENT_USER_ID.
     */
    agentUserId: string | null;
  } & PhotonIdentity;
}

/** Message status in Photon's send response (`SentMessageStatus`). */
export type ProviderMessageStatus = "dispatched" | "accepted" | "delivered" | "failed";

export type SendOutcome =
  | {
      ok: true;
      /** `pho_msg_...` (live) or `mock_msg_...` (mock); null if the response had none. */
      providerMessageId: string | null;
      providerStatus: ProviderMessageStatus;
      /** Photon failure code when an idempotent replay returns an already failed message. */
      failureCode: string | null;
      /** Photon answered `Idempotent-Replayed: true`: no new message was created. */
      replayed: boolean;
      identity: PhotonIdentity;
    }
  | {
      ok: false;
      /** True for outages, timeouts, and rate limits; false when Photon refused the message. */
      retryable: boolean;
      failureCode: string;
      identity: PhotonIdentity;
    };

export interface PhotonTransport {
  readonly mode: "mock" | "live";
  send(message: OutboundMessage): Promise<SendOutcome>;
}
