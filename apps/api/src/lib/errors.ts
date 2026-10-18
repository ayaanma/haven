import type { ApiErrorCode } from "@haven/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorIssue {
  path: string;
  message: string;
}

/** Throw from any handler or service; app.ts turns it into the standard error envelope. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly issues?: ErrorIssue[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, issues?: ErrorIssue[]) =>
  new HttpError(400, "invalid_request", message, issues);
export const unauthorized = (message = "Missing or invalid session token") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "This session lacks the required scope") =>
  new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const rateLimited = (message = "Too many attempts; try again later") =>
  new HttpError(429, "rate_limited", message);
export const unavailable = (message: string) => new HttpError(503, "unavailable", message);

/**
 * Placeholder for work owned by a feature agent. Routes that reach it answer
 * 501 `not_implemented`, so the API surface is complete and compile-safe before
 * every feature lands.
 */
export class NotImplementedError extends HttpError {
  constructor(feature: string) {
    super(501, "not_implemented", `${feature} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
