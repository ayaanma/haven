import { z } from "zod";

/** Unix epoch milliseconds (UTC). Every Haven timestamp uses this representation. */
export const TimestampMsSchema = z.number().int().nonnegative();
export type TimestampMs = z.infer<typeof TimestampMsSchema>;

/** A finite IEEE-754 number. Zod 4 already rejects NaN and ±Infinity for z.number(). */
export const FiniteNumberSchema = z.number();

/** E.164 phone number: `+`, country code, subscriber number, at most 15 digits total. */
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
export const E164PhoneNumberSchema = z
  .string()
  .regex(E164_PATTERN, { error: "Phone numbers must be E.164, for example +14155550123" });
export type E164PhoneNumber = z.infer<typeof E164PhoneNumberSchema>;

/**
 * Prefixes for identifiers minted by the Haven backend. The body is 24 lowercase
 * base32 characters (120 random bits), e.g. `alt_3k9x0q8m2c7v4b1n6z5r8t0w`.
 */
export const ID_PREFIXES = {
  alert: "alt",
  contact: "ctc",
  session: "ses",
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export const ID_BODY_LENGTH = 24;
export const ID_BODY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[${ID_BODY_ALPHABET}]{${ID_BODY_LENGTH}}$`);
}

export const AlertIdSchema = z
  .string()
  .regex(idPattern(ID_PREFIXES.alert), { error: "Invalid alert ID" });
export type AlertId = z.infer<typeof AlertIdSchema>;

export const ContactIdSchema = z
  .string()
  .regex(idPattern(ID_PREFIXES.contact), { error: "Invalid contact ID" });
export type ContactId = z.infer<typeof ContactIdSchema>;

/**
 * Client-generated UUID that makes SOS submission idempotent. The G2 app mints it
 * once when the countdown expires and reuses it for every retry of that SOS.
 */
export const ClientAlertIdSchema = z.uuid();
export type ClientAlertId = z.infer<typeof ClientAlertIdSchema>;

/** Lowercase hex SHA-256 digest. */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Expected a lowercase hex SHA-256 digest" });

/** Single-line human-readable text with control characters rejected. */
export function plainTextSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/\p{Cc}/u.test(value), { error: "Control characters are not allowed" });
}

/** Free text that may contain newlines (for example a contact's reply), with other control characters rejected. */
export function multilineTextSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/[^\P{Cc}\n\t]/u.test(value), {
      error: "Control characters other than newline and tab are not allowed",
    });
}
