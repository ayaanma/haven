// Owner: Agent 1. Placeholder created by the foundation commit.
//
// Implement each method with deps.http.json({ method, path: apiPaths.x(...), schema }) using the
// response schemas from @haven/contracts (CreateAlertResponseSchema, AlertEventsPageSchema, ...).
// createSession must also deps.sessions.save({ token, expiresAt }) and call with auth: false.
// createAlert is idempotent on clientAlertId: retry the SAME request on retryable errors.
import type { ApiClientDeps, HavenApiClient } from "../core/interfaces";

const notImplemented = (method: string) =>
  Promise.reject(new Error(`HavenApiClient.${method} is not implemented yet (Agent 1)`));

export function createApiClient(_deps: ApiClientDeps): HavenApiClient {
  return {
    createSession: () => notImplemented("createSession"),
    createAlert: () => notImplemented("createAlert"),
    getAlert: () => notImplemented("getAlert"),
    getAlertEvents: () => notImplemented("getAlertEvents"),
    getContacts: () => notImplemented("getContacts"),
    saveContacts: () => notImplemented("saveContacts"),
  };
}
