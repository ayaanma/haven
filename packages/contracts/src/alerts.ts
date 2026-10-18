import { z } from "zod";
import { AlertIdSchema, ClientAlertIdSchema, ContactIdSchema, TimestampMsSchema } from "./common";
import { LocationFixSchema } from "./location";
import { MotionSummarySchema } from "./motion";

/**
 * Body of `POST /api/v1/alerts`. Sent by the G2 app the moment the 5-second
 * countdown expires. The backend must dispatch the initial SOS without waiting
 * for AI analysis.
 */
export const SOSRequestSchema = z.strictObject({
  /** Idempotency key. Retries of the same SOS reuse it; the backend never sends twice. */
  clientAlertId: ClientAlertIdSchema,
  /** When the wearer's single press started the countdown (phone clock). */
  activatedAt: TimestampMsSchema,
  location: LocationFixSchema.optional(),
  motionSummary: MotionSummarySchema.optional(),
});
export type SOSRequest = z.infer<typeof SOSRequestSchema>;

/**
 * Server-side alert lifecycle.
 * - `received`: persisted; initial notifications not attempted yet.
 * - `notifying`: initial notifications are being submitted to Photon.
 * - `notified`: Photon accepted at least one initial message. Acceptance is NOT delivery.
 * - `notification_failed`: no initial message was accepted (no eligible contacts, or every send failed).
 */
export const AlertStateSchema = z.enum([
  "received",
  "notifying",
  "notified",
  "notification_failed",
]);
export type AlertState = z.infer<typeof AlertStateSchema>;

/**
 * Status of one Haven message to one contact, mirroring Photon 2.0 message statuses:
 *
 * | Haven                  | Photon 2.0                                   | Meaning                                              |
 * |------------------------|----------------------------------------------|------------------------------------------------------|
 * | `queued`               | (no request yet)                             | Haven has not received Photon's response             |
 * | `photon_accepted`      | 202 response, status `dispatched`            | Photon persisted it for asynchronous delivery        |
 * | `delivery_unconfirmed` | `message.accepted` (terminal)                | Provider accepted; delivery confirmation unavailable |
 * | `delivered`            | `message.delivered` (terminal)               | Delivery confirmed by the provider                   |
 * | `failed`               | request rejected, or `message.failed`        | Will not be delivered                                |
 *
 * Note the naming trap: Photon's `accepted` status is terminal and means delivery could
 * not be confirmed. Haven's "Photon accepted" means Photon took the message (HTTP 202).
 */
export const NotificationStatusSchema = z.enum([
  "queued",
  "photon_accepted",
  "delivery_unconfirmed",
  "delivered",
  "failed",
]);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

/** Statuses that count toward `initialAcceptedCount`. */
export const ACCEPTED_NOTIFICATION_STATUSES: readonly NotificationStatus[] = [
  "photon_accepted",
  "delivery_unconfirmed",
  "delivered",
];

export function isAcceptedNotificationStatus(status: NotificationStatus): boolean {
  return ACCEPTED_NOTIFICATION_STATUSES.includes(status);
}

/** Which Haven message a notification belongs to. */
export const NotificationKindSchema = z.enum(["initial_sos", "context_update", "recording_link"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const ContactNotificationStatusSchema = z.object({
  contactId: ContactIdSchema,
  displayName: z.string().min(1).max(40),
  status: NotificationStatusSchema,
  updatedAt: TimestampMsSchema,
  /** Photon failure code (e.g. `recipient_unreachable`) or a Haven code; null unless failed. */
  failureCode: z.string().min(1).max(64).nullable(),
});
export type ContactNotificationStatus = z.infer<typeof ContactNotificationStatusSchema>;

export const AiAnalysisStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "insufficient_information",
  "failed",
  "skipped",
]);
export type AiAnalysisStatus = z.infer<typeof AiAnalysisStatusSchema>;

/** Server-side view of the alert's recording (see recording.ts for upload details). */
export const AlertRecordingStatusSchema = z.enum([
  "not_started",
  "receiving",
  "finalizing",
  "completed",
  "failed",
]);
export type AlertRecordingStatus = z.infer<typeof AlertRecordingStatusSchema>;

export const AlertRecordSchema = z
  .object({
    alertId: AlertIdSchema,
    clientAlertId: ClientAlertIdSchema,
    activatedAt: TimestampMsSchema,
    /** Server clock when the SOS request was persisted. */
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    state: AlertStateSchema,
    location: LocationFixSchema.nullable(),
    /** Initial SOS status for every contact that was eligible when the alert was created. */
    recipients: z.array(ContactNotificationStatusSchema),
    initialAcceptedCount: z.number().int().nonnegative(),
    initialDeliveredCount: z.number().int().nonnegative(),
    totalRecipients: z.number().int().nonnegative(),
    aiAnalysis: z.object({
      status: AiAnalysisStatusSchema,
      updatedAt: TimestampMsSchema.nullable(),
    }),
    recording: z.object({
      status: AlertRecordingStatusSchema,
      recordingId: z.uuid().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
      /** Contacts whose recording-link message Photon accepted. */
      notificationAcceptedCount: z.number().int().nonnegative(),
    }),
    /** Cursor of the newest event for this alert; pass it to the events endpoint to resume. */
    latestEventCursor: z.string().nullable(),
  })
  .refine((a) => a.recipients.length === a.totalRecipients, {
    error: "recipients.length must equal totalRecipients",
  })
  .refine((a) => a.initialDeliveredCount <= a.initialAcceptedCount, {
    error: "initialDeliveredCount must be <= initialAcceptedCount",
  })
  .refine((a) => a.initialAcceptedCount <= a.totalRecipients, {
    error: "initialAcceptedCount must be <= totalRecipients",
  });
export type AlertRecord = z.infer<typeof AlertRecordSchema>;

/** `POST /api/v1/alerts` response. `created` is false when `clientAlertId` was seen before. */
export const CreateAlertResponseSchema = z.object({
  alert: AlertRecordSchema,
  created: z.boolean(),
});
export type CreateAlertResponse = z.infer<typeof CreateAlertResponseSchema>;
