import { z } from "zod";
import {
  EmergencyContactInputSchema,
  EmergencyContactSchema,
  MAX_EMERGENCY_CONTACTS,
} from "./contacts";
import { AlertEventSchema, EventCursorSchema } from "./events";

export const API_PREFIX = "/api/v1";

/**
 * Hono route patterns. The backend registers exactly these; docs/API_CONTRACTS.md
 * documents each one. `GET /r/:token` is the public, unguessable recording link.
 */
export const ROUTES = {
  health: "/healthz",
  createSession: "/api/v1/auth/session",
  contacts: "/api/v1/contacts",
  alerts: "/api/v1/alerts",
  alert: "/api/v1/alerts/:alertId",
  alertEvents: "/api/v1/alerts/:alertId/events",
  audioChunks: "/api/v1/alerts/:alertId/audio/chunks",
  audioComplete: "/api/v1/alerts/:alertId/audio/complete",
  photonWebhooks: "/api/v1/photon/webhooks",
  recordingShare: "/r/:token",
} as const;

/** Concrete paths for clients. */
export const apiPaths = {
  createSession: () => ROUTES.createSession,
  contacts: () => ROUTES.contacts,
  alerts: () => ROUTES.alerts,
  alert: (alertId: string) => `/api/v1/alerts/${encodeURIComponent(alertId)}`,
  alertEvents: (alertId: string) => `/api/v1/alerts/${encodeURIComponent(alertId)}/events`,
  audioChunks: (alertId: string) => `/api/v1/alerts/${encodeURIComponent(alertId)}/audio/chunks`,
  audioComplete: (alertId: string) =>
    `/api/v1/alerts/${encodeURIComponent(alertId)}/audio/complete`,
} as const;

export const ApiErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "not_implemented",
  "unavailable",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Every non-2xx JSON response has this shape. */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    /** Present for `invalid_request`: Zod issue paths and messages. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ContactsResponseSchema = z.object({
  contacts: z.array(EmergencyContactSchema).max(MAX_EMERGENCY_CONTACTS),
});
export type ContactsResponse = z.infer<typeof ContactsResponseSchema>;

/**
 * `PUT /api/v1/contacts` replaces the whole list. Entries with an `id` update that
 * contact; entries without one are added (consent `pending`); omitted contacts are deleted.
 * Consent survives an update only when the phone number is unchanged.
 */
export const SaveContactsRequestSchema = z.strictObject({
  contacts: z
    .array(EmergencyContactInputSchema)
    .max(MAX_EMERGENCY_CONTACTS)
    .refine((list) => new Set(list.map((c) => c.phoneNumber)).size === list.length, {
      error: "Phone numbers must be unique",
    })
    .refine(
      (list) => {
        const ids = list.flatMap((c) => (c.id ? [c.id] : []));
        return new Set(ids).size === ids.length;
      },
      { error: "Contact IDs must be unique" },
    ),
});
export type SaveContactsRequest = z.infer<typeof SaveContactsRequestSchema>;

export const ALERT_EVENTS_DEFAULT_LIMIT = 50;
export const ALERT_EVENTS_MAX_LIMIT = 100;

export const GetAlertEventsQuerySchema = z.strictObject({
  /** Return events strictly after this cursor. Omit to start from the beginning. */
  cursor: EventCursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ALERT_EVENTS_MAX_LIMIT)
    .default(ALERT_EVENTS_DEFAULT_LIMIT),
});
export type GetAlertEventsQuery = z.infer<typeof GetAlertEventsQuerySchema>;

export const AlertEventsPageSchema = z.object({
  events: z.array(AlertEventSchema),
  /**
   * Pass this as `cursor` on the next poll. It is the last returned event's cursor,
   * or the request's cursor (possibly null) when nothing new happened.
   */
  nextCursor: EventCursorSchema.nullable(),
  /** True when more events are available right now (the page hit `limit`). */
  hasMore: z.boolean(),
});
export type AlertEventsPage = z.infer<typeof AlertEventsPageSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  photonMode: z.enum(["mock", "live"]),
  llmMode: z.enum(["mock", "live"]),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
