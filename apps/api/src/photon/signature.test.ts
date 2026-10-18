import { describe, expect, it } from "vitest";
import { MOCK_WEBHOOK_SECRET } from "./mock-webhook";
import {
  WEBHOOK_TOLERANCE_MS,
  WebhookSignatureError,
  computeWebhookSignature,
  decodeWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
} from "./signature";

const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
const OTHER = `whsec_${Buffer.from("fedcba9876543210fedcba9876543210").toString("base64")}`;
const NOW = Date.UTC(2026, 9, 18, 19, 30, 0);
const BODY = '{"id":"pho_evt_01k0000000000000000000000a","type":"message.received"}';

function reason(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof WebhookSignatureError) return error.reason;
    throw error;
  }
}

describe("webhook signatures (Standard Webhooks scheme)", () => {
  it("matches the Standard Webhooks reference construction", () => {
    // HMAC-SHA256 over `${id}.${timestamp}.${body}` with the base64-decoded secret.
    const sig = computeWebhookSignature(SECRET, "msg_1", 1_792_000_000, "{}");
    expect(sig).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
    expect(decodeWebhookSecret(SECRET).toString()).toBe("0123456789abcdef0123456789abcdef");
  });

  it("accepts a valid signature and returns the delivery ID", () => {
    const headers = signWebhook(SECRET, BODY, { webhookId: "msg_1", timestampMs: NOW });
    expect(verifyWebhookSignature({ secrets: [SECRET], headers, rawBody: BODY, nowMs: NOW })).toBe(
      "msg_1",
    );
  });

  it("accepts any listed signature and any configured secret (rotation overlap)", () => {
    const headers = signWebhook(SECRET, BODY, { webhookId: "msg_1", timestampMs: NOW });
    const stale = computeWebhookSignature(OTHER, "msg_1", Math.floor(NOW / 1000), BODY);
    headers["webhook-signature"] = `${stale} ${headers["webhook-signature"]}`;
    expect(
      reason(() =>
        verifyWebhookSignature({ secrets: [SECRET], headers, rawBody: BODY, nowMs: NOW }),
      ),
    ).toBeNull();
    expect(
      reason(() =>
        verifyWebhookSignature({ secrets: [OTHER, SECRET], headers, rawBody: BODY, nowMs: NOW }),
      ),
    ).toBeNull();
  });

  it("accepts svix-prefixed headers", () => {
    const signed = signWebhook(SECRET, BODY, { webhookId: "msg_1", timestampMs: NOW });
    const headers = {
      "svix-id": signed["webhook-id"]!,
      "svix-timestamp": signed["webhook-timestamp"]!,
      "svix-signature": signed["webhook-signature"]!,
    };
    expect(
      reason(() =>
        verifyWebhookSignature({ secrets: [SECRET], headers, rawBody: BODY, nowMs: NOW }),
      ),
    ).toBeNull();
  });

  it.each([
    ["wrong secret", { secret: OTHER }, "signature_mismatch"],
    ["tampered body", { body: BODY.replace("received", "delivered") }, "signature_mismatch"],
    [
      "old timestamp (replay)",
      { now: NOW + WEBHOOK_TOLERANCE_MS + 1_000 },
      "timestamp_out_of_tolerance",
    ],
    ["future timestamp", { now: NOW - WEBHOOK_TOLERANCE_MS - 1_000 }, "timestamp_out_of_tolerance"],
    ["missing headers", { drop: "webhook-signature" }, "missing_headers"],
    ["non-v1 signature", { signature: "v0,abc" }, "no_v1_signature"],
    ["non-numeric timestamp", { timestamp: "soon" }, "invalid_timestamp"],
  ])("rejects a %s", (_name, change, expected) => {
    const c = change as {
      secret?: string;
      body?: string;
      now?: number;
      drop?: string;
      signature?: string;
      timestamp?: string;
    };
    const headers = signWebhook(c.secret ?? SECRET, BODY, { webhookId: "msg_1", timestampMs: NOW });
    if (c.drop) delete headers[c.drop];
    if (c.signature) headers["webhook-signature"] = c.signature;
    if (c.timestamp) headers["webhook-timestamp"] = c.timestamp;
    expect(
      reason(() =>
        verifyWebhookSignature({
          secrets: [SECRET],
          headers,
          rawBody: c.body ?? BODY,
          nowMs: c.now ?? NOW,
        }),
      ),
    ).toBe(expected);
  });

  it("only accepts the mock secret when it is configured", () => {
    const headers = signWebhook(MOCK_WEBHOOK_SECRET, BODY, { webhookId: "m", timestampMs: NOW });
    expect(
      reason(() =>
        verifyWebhookSignature({ secrets: [SECRET], headers, rawBody: BODY, nowMs: NOW }),
      ),
    ).toBe("signature_mismatch");
  });

  it("refuses malformed secrets", () => {
    expect(() => decodeWebhookSecret("whsec_not base64!")).toThrow();
    expect(() => decodeWebhookSecret("whsec_c2hvcnQ=")).toThrow(/too short/);
  });
});
