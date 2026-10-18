import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ID_BODY_ALPHABET, ID_BODY_LENGTH, type IdPrefix } from "@haven/contracts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time string comparison that does not leak length through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** New server-minted ID such as `alt_3k9x0q8m2c7v4b1n6z5r8t0w` (120 random bits). */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes((ID_BODY_LENGTH * 5) / 8);
  let bits = 0;
  let value = 0;
  let body = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      body += ID_BODY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${prefix}_${body}`;
}
