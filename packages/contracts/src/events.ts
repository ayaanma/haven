import { z } from "zod";
import {
  AlertIdSchema,
  ClientAlertIdSchema,
  ContactIdSchema,
  TimestampMsSchema,
  multilineTextSchema,
} from "./common";
import { NotificationKindSchema, NotificationStatusSchema } from "./alerts";
import { ContextFailureReasonSchema, ContextResultSchema } from "./context";
import { RecordingIdSchema } from "./recording";

/**
 * Every fact the G2 app shows the wearer comes from this append-only event log.
 * Event IDs are strictly increasing integers assigned by SQLite, so ordering is
 * total across all alerts and the events endpoint can resume from any cursor.
 *
 * The distinctions below are deliberate. Do not merge them in UI copy:
 * - `sos.received`: the backend persisted the SOS. Nobody has been contacted yet.
 * - `notification.photon_accepted`: Photon took one message for asynchronous delivery (HTTP 202).
 * - `notification.delivered`: the provider confirmed delivery of one message.
 * - `notification.delivery_unconfirmed`: the provider accepted it but cannot confirm delivery.
 * - `notification.failed`: one message will not be delivered.
 * - `alert.initial_notification_accepted`: the FIRST initial SOS message was accepted.
 *   This is the trigger for the G2 app to start recording automatically.
 * - `contact.responded`: an authenticated reply from a configured contact (via a verified
 *   Photon webhook). This is the only source for "<name>: <text>" on the HUD.
 * - `recording.*`: the server's view of the audio upload.
 */
export const AlertEventTypeSchema = z.enum([
  "sos.received",
  "notification.photon_accepted",
  "notification.delivery_unconfirmed",
  "notification.delivered",
  "notification.failed",
  "alert.initial_notification_accepted",
  "alert.initial_notification_failed",
  "context.completed",
  "context.insufficient_information",
  "context.failed",
  "contact.responded",
  "recording.started",
  "recording.upload_completed",
  "recording.notification_accepted",
  "recording.failed",
]);
export type AlertEventType = z.infer<typeof AlertEventTypeSchema>;

const NotificationPayloadSchema = z.object({
  kind: NotificationKindSchema,
  contactId: ContactIdSchema,
  displayName: z.string().min(1).max(40),
  status: NotificationStatusSchema,
  failureCode: z.string().min(1).max(64).nullable(),
});

/** Payload schema for each event type. */
export const AlertEventPayloadSchemas = {
  "sos.received": z.object({
    clientAlertId: ClientAlertIdSchema,
    activatedAt: TimestampMsSchema,
    hasLocation: z.boolean(),
    hasMotionSummary: z.boolean(),
    totalRecipients: z.number().int().nonnegative(),
  }),
  "notification.photon_accepted": NotificationPayloadSchema,
  "notification.delivery_unconfirmed": NotificationPayloadSchema,
  "notification.delivered": NotificationPayloadSchema,
  "notification.failed": NotificationPayloadSchema,
  "alert.initial_notification_accepted": z.object({
    acceptedCount: z.number().int().positive(),
    totalRecipients: z.number().int().positive(),
  }),
  "alert.initial_notification_failed": z.object({
    reason: z.enum(["no_eligible_contacts", "all_sends_failed", "provider_unavailable"]),
    totalRecipients: z.number().int().nonnegative(),
  }),
  "context.completed": z.object({ result: ContextResultSchema }),
  "context.insufficient_information": z.object({ result: ContextResultSchema }),
  "context.failed": z.object({ reason: ContextFailureReasonSchema }),
  "contact.responded": z.object({
    contactId: ContactIdSchema,
    displayName: z.string().min(1).max(40),
    text: multilineTextSchema(500),
    /** When Photon received the reply. */
    receivedAt: TimestampMsSchema,
  }),
  "recording.started": z.object({
    recordingId: RecordingIdSchema,
  }),
  "recording.upload_completed": z.object({
    recordingId: RecordingIdSchema,
    durationMs: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    byteLength: z.number().int().nonnegative(),
  }),
  "recording.notification_accepted": z.object({
    recordingId: RecordingIdSchema,
    acceptedCount: z.number().int().positive(),
    totalRecipients: z.number().int().positive(),
  }),
  "recording.failed": z.object({
    recordingId: RecordingIdSchema.nullable(),
    reason: z.enum(["missing_chunks", "storage_error", "notification_failed", "too_large"]),
  }),
} as const satisfies Record<AlertEventType, z.ZodType>;

export type AlertEventPayload<T extends AlertEventType> = z.infer<
  (typeof AlertEventPayloadSchemas)[T]
>;

function body<T extends AlertEventType>(type: T) {
  return z.object({ type: z.literal(type), payload: AlertEventPayloadSchemas[type] });
}

/** Discriminated union of every `{ type, payload }` pair. Producers append these. */
export const AlertEventBodySchema = z.discriminatedUnion("type", [
  body("sos.received"),
  body("notification.photon_accepted"),
  body("notification.delivery_unconfirmed"),
  body("notification.delivered"),
  body("notification.failed"),
  body("alert.initial_notification_accepted"),
  body("alert.initial_notification_failed"),
  body("context.completed"),
  body("context.insufficient_information"),
  body("context.failed"),
  body("contact.responded"),
  body("recording.started"),
  body("recording.upload_completed"),
  body("recording.notification_accepted"),
  body("recording.failed"),
]);
export type AlertEventBody = z.infer<typeof AlertEventBodySchema>;

/** Opaque resumable cursor. Currently the decimal event ID; clients must not parse it. */
export const EventCursorSchema = z.string().regex(/^[0-9]{1,15}$/, { error: "Invalid cursor" });
export type EventCursor = z.infer<typeof EventCursorSchema>;

export const AlertEventBaseSchema = z.object({
  /** Strictly increasing across the whole database. */
  id: z.number().int().positive(),
  alertId: AlertIdSchema,
  /** Server clock when the event was appended. */
  timestampMs: TimestampMsSchema,
});

export const AlertEventSchema = z.intersection(AlertEventBaseSchema, AlertEventBodySchema);
export type AlertEvent = z.infer<typeof AlertEventSchema>;

export function eventCursor(event: Pick<AlertEvent, "id">): EventCursor {
  return String(event.id);
}

/** Narrow an event to one type without casts at the call site. */
export function isAlertEventOfType<T extends AlertEventType>(
  event: AlertEvent,
  type: T,
): event is Extract<AlertEvent, { type: T }> {
  return event.type === type;
}
