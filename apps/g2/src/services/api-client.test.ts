import {
  AlertEventsPageSchema,
  ContactsResponseSchema,
  CreateAlertResponseSchema,
  CreateSessionResponseSchema,
} from "@haven/contracts";
import { makeAlertRecord, makeContact, makeSOSRequest } from "@haven/contracts/testing";
import { describe, expect, it } from "vitest";
import type { HavenHttpClient } from "../core/http";
import type { SessionStore } from "../core/session-store";
import { createApiClient } from "./api-client";

describe("Haven API client", () => {
  it("uses contract paths, omits auth for pairing, and stores the session", async () => {
    const requests: unknown[] = [];
    const saved: unknown[] = [];
    const token = `hvn_${"A".repeat(43)}`;
    const http = {
      baseUrl: "http://api.test",
      async json(request: { path: string; auth?: boolean }) {
        requests.push(request);
        return CreateSessionResponseSchema.parse({
          sessionToken: token,
          tokenType: "Bearer",
          expiresAt: Date.now() + 60_000,
          scopes: ["contacts:read"],
        });
      },
    } as HavenHttpClient;
    const sessions = {
      async save(value: unknown) {
        saved.push(value);
      },
    } as SessionStore;
    const api = createApiClient({ http, sessions });
    const response = await api.createSession({ pairingCode: "pair-me" });
    expect(response.sessionToken).toBe(token);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/auth/session",
      auth: false,
    });
    expect(saved).toEqual([{ token, expiresAt: response.expiresAt }]);
  });

  it("retries only retryable alert errors and reuses the identical request", async () => {
    const bodies: unknown[] = [];
    let attempts = 0;
    const http = {
      baseUrl: "http://api.test",
      async json(request: { body?: unknown; schema: unknown }) {
        bodies.push(request.body);
        attempts++;
        if (attempts < 3) throw { retryable: true };
        return CreateAlertResponseSchema.parse({ alert: makeAlertRecord(), created: true });
      },
    } as HavenHttpClient;
    const api = createApiClient({ http, sessions: {} as SessionStore });
    const request = makeSOSRequest();
    await api.createAlert(request);
    expect(attempts).toBe(3);
    expect(bodies).toEqual([request, request, request]);
  });

  it("validates and routes alert, event, and contact requests", async () => {
    const requests: Array<{ method: string; path: string; query?: unknown; body?: unknown }> = [];
    const alert = makeAlertRecord();
    const responses = [
      alert,
      AlertEventsPageSchema.parse({ events: [], nextCursor: "4", hasMore: false }),
      ContactsResponseSchema.parse({ contacts: [makeContact()] }),
      ContactsResponseSchema.parse({ contacts: [] }),
    ];
    const http = {
      baseUrl: "http://api.test",
      async json(request: (typeof requests)[number]) {
        requests.push(request);
        return responses.shift();
      },
    } as HavenHttpClient;
    const api = createApiClient({ http, sessions: {} as SessionStore });
    await api.getAlert(alert.alertId);
    await api.getAlertEvents(alert.alertId, "4");
    await api.getContacts();
    await api.saveContacts([]);
    expect(requests).toMatchObject([
      { method: "GET", path: `/api/v1/alerts/${alert.alertId}` },
      { method: "GET", path: `/api/v1/alerts/${alert.alertId}/events`, query: { cursor: "4" } },
      { method: "GET", path: "/api/v1/contacts" },
      { method: "PUT", path: "/api/v1/contacts", body: { contacts: [] } },
    ]);
  });
});
