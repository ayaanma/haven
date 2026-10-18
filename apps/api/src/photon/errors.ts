// Classify errors thrown by @photon-ai/api into retryable outages and permanent refusals.
// Photon 2.0 errors are RFC 9457 problem documents with a stable `code`
// (https://photon.codes/docs/beta/problems/catalog.md). The client throws:
//   ApiError                 non-2xx answer (status, parsed problem body)
//   TransportError           network failure, timeout, or cancellation
//   ResponseValidationError  2xx body the pinned client could not decode
// Classes are matched by name so this module does not load the client in mock mode.

export interface PhotonErrorClass {
  retryable: boolean;
  /** Haven failure code (≤ 64 chars) stored on the notification row. */
  failureCode: string;
  /** A cached Photon identity that the error shows is stale. */
  resetIdentity?: "user" | "space";
}

const permanent = (failureCode: string): PhotonErrorClass => ({ retryable: false, failureCode });
const transient = (failureCode: string): PhotonErrorClass => ({ retryable: true, failureCode });

/** Problem codes → Haven classification. Unlisted codes fall back to the HTTP status. */
const PROBLEM_CODES: Record<string, PhotonErrorClass> = {
  // Shared iMessage lines only reach peers who messaged the line since their assignment.
  SHARED_LINE_INBOUND_REQUIRED: permanent("recipient_not_opted_in"),
  SHARED_LINE_NOT_ASSIGNED: permanent("recipient_not_assigned"),
  SHARED_LINE_GROUP_UNSUPPORTED: permanent("space_not_sendable"),
  SPACE_NOT_FOUND: { retryable: true, failureCode: "space_not_found", resetIdentity: "space" },
  USER_NOT_FOUND: { retryable: true, failureCode: "user_not_found", resetIdentity: "user" },
  SENDER_NOT_FOUND: permanent("sender_not_found"),
  SENDER_NOT_SENDABLE: permanent("sender_not_sendable"),
  SPACE_NOT_SENDABLE: permanent("space_not_sendable"),
  SPACE_REQUIRES_OWNED_AGENT: permanent("space_requires_owned_agent"),
  SMS_CAMPAIGN_NOT_ELIGIBLE: permanent("sms_campaign_not_eligible"),
  MESSAGE_TOO_LONG: permanent("message_rejected"),
  INVALID_CONTENT: permanent("message_rejected"),
  UNSUPPORTED_CONTENT: permanent("message_rejected"),
  IDEMPOTENCY_KEY_REUSED: permanent("idempotency_conflict"),
  IDEMPOTENCY_REQUEST_IN_PROGRESS: transient("provider_unavailable"),
  IDEMPOTENCY_UNAVAILABLE: transient("provider_unavailable"),
  BILLING_SUSPENDED: permanent("provider_billing_suspended"),
  NOT_AUTHENTICATED: permanent("provider_auth_failed"),
  FORBIDDEN: permanent("provider_forbidden"),
  INSUFFICIENT_SCOPE: permanent("provider_forbidden"),
  RESOURCE_MISMATCH: permanent("provider_forbidden"),
  ORGANIZATION_SSO_REQUIRED: permanent("provider_forbidden"),
  VALIDATION_FAILED: permanent("provider_rejected_request"),
  INVALID_REQUEST: permanent("provider_rejected_request"),
  OPERATION_UNAVAILABLE: transient("provider_unavailable"),
  UPSTREAM_FAILURE: transient("provider_unavailable"),
  UPSTREAM_UNAVAILABLE: transient("provider_unavailable"),
  UPSTREAM_TIMEOUT: transient("provider_timeout"),
  REQUEST_TIMEOUT: transient("provider_timeout"),
  INTERNAL_ERROR: transient("provider_unavailable"),
};

export function isNamedError<N extends string>(
  error: unknown,
  name: N,
): error is Error & { name: N } & Record<string, unknown> {
  return error instanceof Error && error.name === name;
}

/** The problem `code` from an ApiError body, if any. */
export function problemCode(error: unknown): string | null {
  if (!isNamedError(error, "ApiError")) return null;
  const body = error.body;
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = (body as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function classifyPhotonError(error: unknown): PhotonErrorClass {
  if (isNamedError(error, "TransportError")) return transient("provider_unreachable");
  if (isNamedError(error, "ResponseValidationError")) return transient("provider_response_invalid");
  if (isNamedError(error, "ApiError")) {
    const known = PROBLEM_CODES[problemCode(error) ?? ""];
    if (known) return known;
    const status = typeof error.status === "number" ? error.status : 0;
    if (status === 408 || status === 504) return transient("provider_timeout");
    if (status === 429) return transient("provider_rate_limited");
    if (status >= 500) return transient("provider_unavailable");
    if (status === 401) return permanent("provider_auth_failed");
    if (status === 402) return permanent("provider_billing_suspended");
    if (status === 403) return permanent("provider_forbidden");
    if (status === 413 || status === 422) return permanent("message_rejected");
    return permanent(`provider_http_${status}`);
  }
  // Anything else is unexpected (for example a bug or a malformed response). Retrying is
  // bounded, and for an emergency message one more attempt is cheaper than giving up early.
  return transient("send_error");
}
