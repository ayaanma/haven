// Photon webhook signature verification.
//
// Photon 2.0 signs webhooks with the Standard Webhooks scheme (https://www.standardwebhooks.com).
// Its public docs only mention the `whsec_` secret and the `webhook-signature` header, but a
// real production delivery (2026-10-18, event message.received) verified with this code:
//
//   webhook-id:        unique delivery ID
//   webhook-timestamp: Unix seconds
//   webhook-signature: space-separated "v1,<base64 HMAC-SHA256>" entries
//   signed content:    `${id}.${timestamp}.${rawBody}`
//   key:               base64-decoded part of the secret after `whsec_`
//
// `svix-*` header names (same scheme) are accepted too. Anything else is rejected: the
// handler fails closed, and a rejected request logs the header names it received.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Accept timestamps this far from the server clock in either direction (replay window). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export class WebhookSignatureError extends Error {
  constructor(readonly reason: string) {
    super(`Webhook signature rejected: ${reason}`);
    this.name = "WebhookSignatureError";
  }
}

export function decodeWebhookSecret(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Webhook secret must be whsec_ followed by base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length < 16) throw new Error("Webhook secret is too short");
  return key;
}

export function computeWebhookSignature(
  secret: string,
  webhookId: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const mac = createHmac("sha256", decodeWebhookSecret(secret))
    .update(`${webhookId}.${timestampSeconds}.${rawBody}`)
    .digest("base64");
  return `v1,${mac}`;
}

/** Headers for a signed request (used by tests and the mock-mode reply simulator). */
export function signWebhook(
  secret: string,
  rawBody: string,
  options: { webhookId: string; timestampMs: number },
): Record<string, string> {
  const timestamp = Math.floor(options.timestampMs / 1000);
  return {
    "webhook-id": options.webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": computeWebhookSignature(secret, options.webhookId, timestamp, rawBody),
  };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  return headers[`webhook-${name}`] ?? headers[`svix-${name}`];
}

/**
 * Throws WebhookSignatureError unless one `v1` signature matches one of `secrets` and the
 * timestamp is within the tolerance. Returns the delivery ID.
 */
export function verifyWebhookSignature(input: {
  secrets: readonly string[];
  headers: Record<string, string>;
  rawBody: string;
  nowMs: number;
  toleranceMs?: number;
}): string {
  const webhookId = header(input.headers, "id");
  const timestamp = header(input.headers, "timestamp");
  const signatures = header(input.headers, "signature");
  if (!webhookId || !timestamp || !signatures) throw new WebhookSignatureError("missing_headers");
  if (webhookId.length > 256) throw new WebhookSignatureError("invalid_id");
  if (!/^\d{1,12}$/.test(timestamp)) throw new WebhookSignatureError("invalid_timestamp");

  const skewMs = Math.abs(input.nowMs - Number(timestamp) * 1000);
  if (skewMs > (input.toleranceMs ?? WEBHOOK_TOLERANCE_MS)) {
    throw new WebhookSignatureError("timestamp_out_of_tolerance");
  }

  const candidates = signatures
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => Buffer.from(entry.slice(3), "base64"));
  if (candidates.length === 0) throw new WebhookSignatureError("no_v1_signature");

  for (const secret of input.secrets) {
    const expected = Buffer.from(
      computeWebhookSignature(secret, webhookId, Number(timestamp), input.rawBody).slice(3),
      "base64",
    );
    for (const candidate of candidates) {
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        return webhookId;
      }
    }
  }
  throw new WebhookSignatureError("signature_mismatch");
}
