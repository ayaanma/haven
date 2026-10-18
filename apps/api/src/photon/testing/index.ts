// Test support for Agent 2's modules. Never imported by production code (lint-enforced).
import { vi } from "vitest";
import type { Hono } from "hono";
import {
  ROUTES,
  type AlertEvent,
  type AlertEventType,
  type AlertRecord,
  type ContextAnalysisOutcome,
  type CreateAlertResponse,
  type SOSRequest,
} from "@haven/contracts";
import { fixtureUuid, makeContextResult, makeSOSRequest } from "@haven/contracts/testing";
import { createApp } from "../../app";
import { buildAlertService } from "../../alerts/service";
import { buildContactsService, createContactsService } from "../../contacts";
import { createContainer, type ServiceContainer } from "../../container";
import { createEventLog, migrate, openDatabase, type Db } from "../../db";
import type { AppEnv } from "../../lib/hono";
import type { HavenContextService, ServiceContext } from "../../lib/interfaces";
import { silentLogger } from "../../lib/logger";
import {
  FakeClock,
  FakeContextService,
  TEST_PAIRING_CODE,
  seedContact,
  testConfig,
} from "../../testing";
import { signedWebhookRequest } from "../mock-webhook";
import { createPhotonNotificationService, type RetryPolicy } from "../notification-service";
import type { PhotonLineService } from "../lines";
import type { OutboundMessage, PhotonTransport, SendOutcome } from "../transport";
import type { PhotonWebhookEvent } from "../webhook-events";
import { createWebhookHandler } from "../webhook-handler";

// ── transport ─────────────────────────────────────────────────────────────────

export type SendScript = (
  message: OutboundMessage,
  attempt: number,
) => SendOutcome | Promise<SendOutcome>;

const noIdentity = { userId: null, spaceId: null };

export const accept =
  (status: "dispatched" | "accepted" | "delivered" = "dispatched"): SendScript =>
  (message) => ({
    ok: true,
    providerMessageId: `pho_msg_test_${message.notificationId}`,
    providerStatus: status,
    failureCode: null,
    replayed: false,
    identity: noIdentity,
  });

export const transientFailure = (failureCode = "provider_unavailable"): SendOutcome => ({
  ok: false,
  retryable: true,
  failureCode,
  identity: noIdentity,
});

export const permanentFailure = (failureCode = "recipient_not_opted_in"): SendOutcome => ({
  ok: false,
  retryable: false,
  failureCode,
  identity: noIdentity,
});

/** Records every send and answers from a script (default: accept everything). */
export class ScriptedTransport implements PhotonTransport {
  readonly mode = "mock" as const;
  readonly calls: OutboundMessage[] = [];
  constructor(public script: SendScript = accept()) {}

  async send(message: OutboundMessage): Promise<SendOutcome> {
    this.calls.push(message);
    const attempt = this.calls.filter((c) => c.notificationId === message.notificationId).length;
    return this.script(message, attempt);
  }

  callsTo(phoneNumber: string): OutboundMessage[] {
    return this.calls.filter((c) => c.recipient.phoneNumber === phoneNumber);
  }
}

/** Fast retries for tests: up to `maxAttempts`, 1 ms apart. */
export const fastRetry = (maxAttempts = 4): RetryPolicy => ({
  maxAttempts,
  delayMs: () => 1,
  deadlineMs: 60 * 60_000,
});

// ── harness ───────────────────────────────────────────────────────────────────

export interface PhotonHarness {
  app: Hono<AppEnv>;
  container: ServiceContainer;
  ctx: ServiceContext;
  db: Db;
  clock: FakeClock;
  token: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<Response>;
  close(): void;
}

export interface PhotonHarnessOptions {
  env?: Record<string, string>;
  db?: Db;
  clock?: FakeClock;
  /** Default: the real transport for the configured PHOTON_MODE. */
  transport?: PhotonTransport;
  retry?: RetryPolicy;
  hourlySendLimit?: number;
  recoverOnStart?: boolean;
  context?: HavenContextService;
  contextTimeoutMs?: number;
  /** Photon shared-line assignments (default: the real service for the config). */
  lines?: PhotonLineService;
}

/**
 * The real app and container, with Agent 2's services built with test options. Unlike
 * createTestHarness it can share a database (to simulate a restart) and inject transports.
 */
export function createPhotonHarness(options: PhotonHarnessOptions = {}): PhotonHarness {
  const clock = options.clock ?? new FakeClock();
  const config = testConfig(options.env);
  const db = options.db ?? openDatabase(":memory:");
  if (!options.db) migrate(db);
  const ctx: ServiceContext = {
    config,
    db,
    clock,
    logger: silentLogger,
    events: createEventLog(db, clock),
  };
  const context =
    options.context ??
    new FakeContextService({ status: "insufficient_information", result: makeContextResult() });
  const notifications = createPhotonNotificationService(ctx, {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.hourlySendLimit ? { hourlySendLimit: options.hourlySendLimit } : {}),
    recoverOnStart: options.recoverOnStart ?? false,
  });
  const contacts = options.lines
    ? buildContactsService(ctx, options.lines)
    : createContactsService(ctx);
  const alerts = buildAlertService(
    ctx,
    { contacts, notifications, context },
    {
      ...(options.contextTimeoutMs ? { contextTimeoutMs: options.contextTimeoutMs } : {}),
      recoverOnStart: options.recoverOnStart ?? false,
    },
  );
  const container = createContainer(config, {
    db,
    clock,
    logger: silentLogger,
    overrides: {
      contacts,
      notifications,
      alerts,
      context,
      photonWebhooks: createWebhookHandler(ctx),
    },
  });
  const app = createApp(container);
  const session = container.sessions.exchangePairingCode(TEST_PAIRING_CODE, "vitest");
  if (!session) throw new Error("test pairing failed");
  const token = session.sessionToken;

  const request = async (path: string, init?: RequestInit) => app.request(path, init);
  const json = async (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  return { app, container, ctx, db, clock, token, request, json, close };
}

// ── data helpers ──────────────────────────────────────────────────────────────

export const PHONES = ["+14155550101", "+14155550102", "+14155550103", "+14155550104"] as const;

/** Verified, enabled contacts (as if each had already texted Haven's line). */
export function seedVerifiedContacts(h: PhotonHarness, count: number): string[] {
  return PHONES.slice(0, count).map((phoneNumber, i) =>
    seedContact(h.db, {
      displayName: ["Mom", "Dad", "Sam", "Alex"][i] ?? "Friend",
      phoneNumber,
      consentStatus: "verified",
      // Distinct creation times keep display order (and recipient order) deterministic.
      now: h.clock.now() - 60_000 + i,
    }),
  );
}

export function sosRequest(n = 1, overrides: Partial<SOSRequest> = {}): SOSRequest {
  return makeSOSRequest({ clientAlertId: fixtureUuid(n), ...overrides });
}

export async function postSOS(
  h: PhotonHarness,
  request: SOSRequest = sosRequest(),
): Promise<{ status: number; body: CreateAlertResponse }> {
  const res = await h.json("POST", ROUTES.alerts, request);
  return { status: res.status, body: (await res.json()) as CreateAlertResponse };
}

export async function getAlert(h: PhotonHarness, alertId: string): Promise<AlertRecord> {
  const res = await h.json("GET", `/api/v1/alerts/${alertId}`);
  if (res.status !== 200) throw new Error(`GET alert ${res.status}`);
  return (await res.json()) as AlertRecord;
}

/** Every event for the alert, read through the public events endpoint. */
export async function allEvents(h: PhotonHarness, alertId: string): Promise<AlertEvent[]> {
  const events: AlertEvent[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query: string = cursor ? `?cursor=${cursor}&limit=100` : "?limit=100";
    const res = await h.json("GET", `/api/v1/alerts/${alertId}/events${query}`);
    const page = (await res.json()) as {
      events: AlertEvent[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    events.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) return events;
  }
}

export const eventTypes = (events: AlertEvent[]) => events.map((e) => e.type);

export async function waitForEvent(
  h: PhotonHarness,
  alertId: string,
  type: AlertEventType,
): Promise<AlertEvent[]> {
  return vi.waitFor(
    async () => {
      const events = await allEvents(h, alertId);
      if (!events.some((e) => e.type === type)) throw new Error(`no ${type} yet`);
      return events;
    },
    { timeout: 3_000, interval: 5 },
  );
}

export interface OutboxRow extends Record<string, unknown> {
  id: number;
  notification_id: string;
  kind: string;
  to_handle: string;
  body: string;
}

export function outbox(h: PhotonHarness): OutboxRow[] {
  return h.db.all<OutboxRow>(
    "SELECT id, notification_id, kind, to_handle, body FROM mock_outbox ORDER BY id",
  );
}

/** Let pending timers and promise chains run (retries scheduled with 1 ms delays). */
export const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

export async function postWebhook(
  h: PhotonHarness,
  event: PhotonWebhookEvent,
  options: { secret?: string; timestampMs?: number; tamper?: (body: string) => string } = {},
): Promise<Response> {
  const { rawBody, headers } = signedWebhookRequest(event, {
    ...(options.secret ? { secret: options.secret } : {}),
    timestampMs: options.timestampMs ?? h.clock.now(),
  });
  return h.request(ROUTES.photonWebhooks, {
    method: "POST",
    headers,
    body: options.tamper ? options.tamper(rawBody) : rawBody,
  });
}

export const completedContext = (
  overrides: Parameters<typeof makeContextResult>[0] = {},
): ContextAnalysisOutcome => ({
  status: "completed",
  result: makeContextResult({
    locationDescription: "Near the intersection of Westwood Blvd and Le Conte Ave (approximate)",
    motionObservations: ["Abrupt head movement about 40 s before the alert"],
    possibleContext: "Movement pattern is consistent with a sudden stop",
    uncertainty: "high",
    evidenceQuality: "limited",
    ...overrides,
  }),
});
