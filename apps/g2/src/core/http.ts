import { ApiErrorBodySchema, type ApiErrorCode } from "@haven/contracts";
import type { z } from "zod";
import type { SessionStore } from "./session-store";

export type HttpErrorCode = ApiErrorCode | "network_error" | "timeout" | "invalid_response";

/** Every failed request rejects with this, never with a raw fetch error. */
export class HavenApiError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
    /** HTTP status; null for network failures and timeouts. */
    readonly status: number | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "HavenApiError";
  }

  /** Worth retrying with the same request (idempotent endpoints only). */
  get retryable(): boolean {
    if (this.code === "network_error" || this.code === "timeout") return true;
    if (this.status === null) return false;
    return this.status === 429 || (this.status >= 500 && this.status !== 501);
  }
}

type Query = Record<string, string | number | undefined>;

interface BaseRequest<S extends z.ZodType> {
  path: string;
  query?: Query;
  schema: S;
  /** Attach the stored session token (default true). */
  auth?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Authenticated transport to the Haven API, shared by the API client (Agent 1) and the
 * audio uploader (Agent 4). Responses are validated against contract schemas.
 */
export interface HavenHttpClient {
  readonly baseUrl: string;
  json<S extends z.ZodType>(
    request: BaseRequest<S> & { method: "GET" | "POST" | "PUT"; body?: unknown },
  ): Promise<z.output<S>>;
  binary<S extends z.ZodType>(
    request: BaseRequest<S> & { method: "POST"; body: Uint8Array; contentType: string },
  ): Promise<z.output<S>>;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export function createHttpClient(options: {
  baseUrl: string;
  sessions: SessionStore;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
}): HavenHttpClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  async function send<S extends z.ZodType>(
    request: BaseRequest<S> & { method: string },
    body: BodyInit | undefined,
    contentType: string | undefined,
  ): Promise<z.output<S>> {
    const url = new URL(baseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: "application/json" });
    if (contentType) headers.set("Content-Type", contentType);
    if (request.auth !== false) {
      const session = await options.sessions.load();
      if (!session)
        throw new HavenApiError("unauthorized", "Not paired with a Haven server", null, null);
      headers.set("Authorization", `Bearer ${session.token}`);
    }

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? defaultTimeout;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await doFetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new HavenApiError("timeout", `Request timed out after ${timeoutMs} ms`, null, null);
      }
      throw new HavenApiError("network_error", `Network error: ${String(error)}`, null, null);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }

    const requestId = response.headers.get("x-request-id");
    let payload: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const parsedError = ApiErrorBodySchema.safeParse(payload);
      if (parsedError.success) {
        const { code, message, requestId: bodyRequestId } = parsedError.data.error;
        throw new HavenApiError(code, message, response.status, bodyRequestId ?? requestId);
      }
      throw new HavenApiError(
        "invalid_response",
        `HTTP ${response.status} without an error body`,
        response.status,
        requestId,
      );
    }

    const parsed = request.schema.safeParse(payload);
    if (!parsed.success) {
      throw new HavenApiError(
        "invalid_response",
        `Response did not match the contract: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        response.status,
        requestId,
      );
    }
    return parsed.data;
  }

  return {
    baseUrl,
    json: (request) =>
      send(
        request,
        request.body === undefined ? undefined : JSON.stringify(request.body),
        request.body === undefined ? undefined : "application/json",
      ),
    binary: (request) =>
      send(request, request.body as Uint8Array<ArrayBuffer>, request.contentType),
  };
}
