import {
  AlertEventsPageSchema,
  AlertRecordSchema,
  ContactsResponseSchema,
  CreateAlertResponseSchema,
  CreateSessionResponseSchema,
  apiPaths,
} from "@haven/contracts";
import type { ApiClientDeps, HavenApiClient } from "../core/interfaces";

const CREATE_ALERT_MAX_ATTEMPTS = 3;

function isRetryable(error: unknown): error is { retryable: true } {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === true
  );
}

export function createApiClient(deps: ApiClientDeps): HavenApiClient {
  return {
    async createSession(request) {
      const response = await deps.http.json({
        method: "POST",
        path: apiPaths.createSession(),
        body: request,
        schema: CreateSessionResponseSchema,
        auth: false,
      });
      await deps.sessions.save({ token: response.sessionToken, expiresAt: response.expiresAt });
      return response;
    },

    async createAlert(request) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await deps.http.json({
            method: "POST",
            path: apiPaths.alerts(),
            body: request,
            schema: CreateAlertResponseSchema,
          });
        } catch (error) {
          if (attempt >= CREATE_ALERT_MAX_ATTEMPTS || !isRetryable(error)) throw error;
        }
      }
    },

    getAlert: (alertId) =>
      deps.http.json({
        method: "GET",
        path: apiPaths.alert(alertId),
        schema: AlertRecordSchema,
      }),

    getAlertEvents: (alertId, cursor) =>
      deps.http.json({
        method: "GET",
        path: apiPaths.alertEvents(alertId),
        query: { cursor: cursor ?? undefined },
        schema: AlertEventsPageSchema,
      }),

    getContacts: () =>
      deps.http.json({
        method: "GET",
        path: apiPaths.contacts(),
        schema: ContactsResponseSchema,
      }),

    saveContacts: (contacts) =>
      deps.http.json({
        method: "PUT",
        path: apiPaths.contacts(),
        body: { contacts },
        schema: ContactsResponseSchema,
      }),
  };
}
