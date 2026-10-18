// Phone number rules for emergency contacts (Agent 2).
//
// The contract accepts any syntactically valid E.164 number. Haven is stricter about
// which numbers it will store or message: it must never message 911, the police, or any
// other emergency or service short code. Every real subscriber number has at least seven
// digits including the country code, while country code + short code (911, 112, 999, 000,
// 110, 119, ...) never exceeds six, so a minimum length rejects all of them. North American
// numbers must also be complete ten-digit numbers with a real area code: N11 codes (211,
// 311, 411, 511, 611, 711, 811, 911) are never area codes.
import { E164_PATTERN } from "@haven/contracts";

const MIN_E164_DIGITS = 7;
const NANP_PATTERN = /^1([2-9]\d{2})([2-9]\d{2})\d{4}$/;
const N11_PATTERN = /^[2-9]11$/;

/** Why Haven refuses to message `phoneNumber`, or null when it is acceptable. */
export function phoneNumberProblem(phoneNumber: string): string | null {
  if (!E164_PATTERN.test(phoneNumber)) {
    return "Phone numbers must be E.164, for example +14155550123";
  }
  const digits = phoneNumber.slice(1);
  if (digits.length < MIN_E164_DIGITS) {
    return "Emergency, police, and other short service numbers cannot be emergency contacts";
  }
  if (digits.startsWith("1")) {
    const nanp = NANP_PATTERN.exec(digits);
    if (!nanp || N11_PATTERN.test(nanp[1] ?? "") || N11_PATTERN.test(nanp[2] ?? "")) {
      return "North American numbers must be a full 10-digit number such as +14155550123";
    }
  }
  return null;
}

/**
 * Photon user handle → E.164, or null when the handle is not a phone number (for example
 * an Apple ID email on iMessage). Formatting characters and a `tel:`/`sms:` scheme are
 * removed; national formats are not guessed, because a wrong guess could match the wrong
 * contact.
 */
export function normalizePhoneHandle(handle: string): string | null {
  const stripped = handle
    .trim()
    .replace(/^(tel|sms|imessage):/i, "")
    .replace(/[\s().-]/g, "");
  return E164_PATTERN.test(stripped) ? stripped : null;
}
