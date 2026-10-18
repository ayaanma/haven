import { z } from "zod";
import {
  ContactIdSchema,
  E164PhoneNumberSchema,
  TimestampMsSchema,
  plainTextSchema,
} from "./common";

export const MAX_EMERGENCY_CONTACTS = 5;

/**
 * Whether a contact has agreed to receive Haven emergency messages.
 *
 * - `pending`: the wearer added the number; the contact has not opted in yet.
 * - `verified`: the backend received an authenticated Photon message from this number
 *   opting in. This is also a Photon requirement: a shared iMessage line can only
 *   message people who have messaged it first.
 * - `revoked`: the contact opted out (for example replied STOP). Never message them.
 *
 * Only the backend changes consent. Clients cannot set it.
 */
export const ContactConsentStatusSchema = z.enum(["pending", "verified", "revoked"]);
export type ContactConsentStatus = z.infer<typeof ContactConsentStatusSchema>;

export const ContactDisplayNameSchema = plainTextSchema(40);

export const EmergencyContactSchema = z.object({
  id: ContactIdSchema,
  displayName: ContactDisplayNameSchema,
  phoneNumber: E164PhoneNumberSchema,
  /** The wearer's on/off switch for this contact. */
  enabled: z.boolean(),
  consent: z.object({
    status: ContactConsentStatusSchema,
    /** When the consent status last changed; null while pending since creation. */
    updatedAt: TimestampMsSchema.nullable(),
  }),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});
export type EmergencyContact = z.infer<typeof EmergencyContactSchema>;

/** What the wearer may edit. Omit `id` to add a contact. */
export const EmergencyContactInputSchema = z.strictObject({
  id: ContactIdSchema.optional(),
  displayName: ContactDisplayNameSchema,
  phoneNumber: E164PhoneNumberSchema,
  enabled: z.boolean(),
});
export type EmergencyContactInput = z.infer<typeof EmergencyContactInputSchema>;

/** A contact receives SOS messages only when the wearer enabled it AND the contact opted in. */
export function isContactEligibleForAlerts(
  contact: Pick<EmergencyContact, "enabled" | "consent">,
): boolean {
  return contact.enabled && contact.consent.status === "verified";
}
