// The SOS lifecycle (Agent 2). createAlert:
//   1. returns the existing alert when clientAlertId was seen before (created: false), and
//      sends nothing again;
//   2. in ONE transaction: snapshots the eligible contacts (enabled, verified, not a blocked
//      number), persists the alert, writes one queued `initial_sos` row per contact (the
//      durable outbox), and appends `sos.received`;
//   3. starts the initial SOS dispatch immediately, without awaiting it or AI analysis;
//   4. lifecycle.ts appends `alert.initial_notification_accepted` on the first accepted
//      message, or `alert.initial_notification_failed` when none can go out;
//   5. separately runs context analysis; a usable result goes out as its own message after
//      the initial round. Failure, timeout, or insufficient information never touch the SOS.
import {
  CONTEXT_ANALYSIS_TIMEOUT_MS,
  ContextAnalysisOutcomeSchema,
  EmergencySensorSnapshotSchema,
  LOCATION_STALE_AFTER_MS,
  MAX_EMERGENCY_CONTACTS,
  SOS_COUNTDOWN_MS,
  locationAgeMs,
  type AlertRecord,
  type ContextAnalysisOutcome,
  type ContextResult,
  type EmergencySensorSnapshot,
  type NotificationKind,
  type SOSRequest,
  AlertIdSchema,
} from "@haven/contracts";
import { phoneNumberProblem } from "../contacts/phone";
import { listEligibleContactRows } from "../contacts/repository";
import { newId } from "../lib/crypto";
import type {
  AlertService,
  ContactsService,
  HavenContextService,
  HavenNotificationService,
  NotificationBatchResult,
  ServiceContext,
} from "../lib/interfaces";
import { errorFields } from "../lib/logger";
import { settleInitialNotification } from "./lifecycle";
import {
  applyNotificationStatus,
  buildAlertRecord,
  ensureNotificationRow,
  getAlertRow,
  getAlertRowByClientId,
  listNotificationRows,
  markAlertNotifying,
} from "./store";

export interface AlertServiceDeps {
  contacts: ContactsService;
  notifications: HavenNotificationService;
  context: HavenContextService;
}

export interface AlertServiceOptions {
  /** Hard cap on one analysis call, in case a context service breaks its own timeout. */
  contextTimeoutMs?: number;
  /** Mark analyses interrupted by a restart as failed, shortly after startup (default true). */
  recoverOnStart?: boolean;
  schedule?: (callback: () => void, delayMs: number) => void;
}

const DISPATCH_REDO_DELAYS_MS = [1_000, 2_000, 4_000];

const defaultSchedule = (callback: () => void, delayMs: number) => {
  setTimeout(callback, delayMs).unref();
};

export function buildAlertService(
  ctx: ServiceContext,
  deps: AlertServiceDeps,
  options: AlertServiceOptions = {},
): AlertService {
  const { db } = ctx;
  const log = ctx.logger.child({ module: "alerts" });
  const schedule = options.schedule ?? defaultSchedule;
  const contextTimeoutMs = options.contextTimeoutMs ?? CONTEXT_ANALYSIS_TIMEOUT_MS + 2_000;
  /** Initial dispatch rounds in flight; the context update waits for its alert's round. */
  const initialRounds = new Map<string, Promise<void>>();
  /** Alerts created by this process (startup recovery leaves them alone). */
  const ownAlerts = new Set<string>();

  function currentRecord(alertId: string): AlertRecord | null {
    const row = getAlertRow(db, alertId);
    return row ? buildAlertRecord(ctx, row) : null;
  }

  /**
   * The Photon notification service persists its own results; this applies results from
   * any other HavenNotificationService (fakes in tests) the same way. It never moves a row
   * that already left `queued`, so with the real service it changes nothing.
   */
  function reconcile(alertId: string, kind: NotificationKind, batch: NotificationBatchResult) {
    const rows = new Map(listNotificationRows(db, alertId, kind).map((r) => [r.contact_id, r]));
    for (const result of batch.results) {
      const row = rows.get(result.contactId);
      if (row?.status === "queued" && result.status !== "queued") {
        applyNotificationStatus(ctx, row.id, {
          status: result.status,
          failureCode: result.failureCode,
        });
      }
    }
  }

  function dispatchInitial(alertId: string, redo = 0): Promise<void> {
    const running = initialRounds.get(alertId);
    if (running) return running;
    const round = (async () => {
      markAlertNotifying(db, alertId, ctx.clock.now());
      const alert = currentRecord(alertId);
      if (!alert) return;
      try {
        const batch = await deps.notifications.sendInitialSOS(alert);
        reconcile(alertId, "initial_sos", batch);
        log.info("initial SOS dispatched", {
          alertId,
          totalRecipients: batch.totalRecipients,
          acceptedCount: batch.acceptedCount,
          failedCount: batch.failedCount,
        });
      } catch (error) {
        log.error("initial SOS dispatch failed", { alertId, redo, ...errorFields(error) });
        const delay = DISPATCH_REDO_DELAYS_MS[redo];
        if (delay !== undefined) {
          schedule(() => void dispatchInitial(alertId, redo + 1), delay);
        }
      }
      settleInitialNotification(ctx, alertId);
    })().finally(() => initialRounds.delete(alertId));
    initialRounds.set(alertId, round);
    return round;
  }

  async function analyze(
    alert: AlertRecord,
    snapshot: EmergencySensorSnapshot,
  ): Promise<ContextAnalysisOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ContextAnalysisOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: "failed", reason: "timeout" }), contextTimeoutMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([
        deps.context.analyzeEmergencyContext(alert, snapshot),
        timeout,
      ]);
      const parsed = ContextAnalysisOutcomeSchema.safeParse(outcome);
      return parsed.success ? parsed.data : { status: "failed", reason: "invalid_output" };
    } catch (error) {
      log.warn("context analysis threw", { alertId: alert.alertId, ...errorFields(error) });
      return { status: "failed", reason: "provider_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  function recordOutcome(alertId: string, outcome: ContextAnalysisOutcome): boolean {
    const now = ctx.clock.now();
    return db.transaction(() => {
      const { changes } = db.run(
        `UPDATE alerts SET ai_status = ?, ai_updated_at = ?, ai_result_json = ?, updated_at = ?
         WHERE id = ? AND ai_status = 'running'`,
        outcome.status,
        now,
        outcome.status === "failed" ? null : JSON.stringify(outcome.result),
        now,
        alertId,
      );
      if (changes === 0) return false;
      if (outcome.status === "failed") {
        ctx.events.append(alertId, { type: "context.failed", payload: { reason: outcome.reason } });
      } else if (outcome.status === "completed") {
        ctx.events.append(alertId, {
          type: "context.completed",
          payload: { result: outcome.result },
        });
      } else {
        ctx.events.append(alertId, {
          type: "context.insufficient_information",
          payload: { result: outcome.result },
        });
      }
      return true;
    });
  }

  async function sendContextUpdate(alertId: string, result: ContextResult): Promise<void> {
    // The follow-up must never reach a contact before the SOS itself.
    await initialRounds.get(alertId);
    try {
      const batch = await deps.notifications.sendContextUpdate(alertId, result);
      reconcile(alertId, "context_update", batch);
      log.info("context update dispatched", {
        alertId,
        totalRecipients: batch.totalRecipients,
        acceptedCount: batch.acceptedCount,
      });
    } catch (error) {
      log.error("context update dispatch failed", { alertId, ...errorFields(error) });
    }
  }

  async function runContextAnalysis(alertId: string, request: SOSRequest): Promise<void> {
    const started = db.run(
      `UPDATE alerts SET ai_status = 'running', ai_updated_at = ?
       WHERE id = ? AND ai_status = 'pending'`,
      ctx.clock.now(),
      alertId,
    );
    const alert = currentRecord(alertId);
    if (started.changes === 0 || !alert) return;
    const outcome = await analyze(alert, sensorSnapshot(request));
    log.info("context analysis finished", { alertId, aiStatus: outcome.status });
    if (recordOutcome(alertId, outcome) && outcome.status !== "failed") {
      await sendContextUpdate(alertId, outcome.result);
    }
  }

  function recoverInterruptedAnalyses(): void {
    const stuck = db.all<{ id: string }>(
      "SELECT id FROM alerts WHERE ai_status IN ('pending', 'running')",
    );
    for (const { id } of stuck) {
      if (ownAlerts.has(id)) continue;
      const now = ctx.clock.now();
      db.transaction(() => {
        const { changes } = db.run(
          `UPDATE alerts SET ai_status = 'failed', ai_updated_at = ?, updated_at = ?
           WHERE id = ? AND ai_status IN ('pending', 'running')`,
          now,
          now,
          id,
        );
        if (changes === 1) {
          ctx.events.append(id, { type: "context.failed", payload: { reason: "timeout" } });
        }
      });
    }
  }

  if (options.recoverOnStart ?? true) {
    schedule(() => {
      try {
        recoverInterruptedAnalyses();
      } catch (error) {
        log.error("context recovery failed", errorFields(error));
      }
    }, 0);
  }

  return {
    async createAlert(request, sessionId) {
      const now = ctx.clock.now();
      const outcome = db.transaction(() => {
        const existing = getAlertRowByClientId(db, request.clientAlertId);
        if (existing) return { alertId: existing.id, created: false, recipients: 0 };

        const alertId = newId("alt");
        const recipients = listEligibleContactRows(db)
          .filter((contact) => phoneNumberProblem(contact.phone_number) === null)
          .slice(0, MAX_EMERGENCY_CONTACTS);
        db.run(
          `INSERT INTO alerts (id, client_alert_id, session_id, activated_at, created_at,
             updated_at, state, location_json, motion_summary_json, ai_status)
           VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
          alertId,
          request.clientAlertId,
          sessionId,
          request.activatedAt,
          now,
          now,
          request.location ? JSON.stringify(request.location) : null,
          request.motionSummary ? JSON.stringify(request.motionSummary) : null,
          // Nobody to send AI context to, so no analysis runs.
          recipients.length > 0 ? "pending" : "skipped",
        );
        for (const contact of recipients) {
          ensureNotificationRow(db, alertId, contact, "initial_sos", now);
        }
        ctx.events.append(alertId, {
          type: "sos.received",
          payload: {
            clientAlertId: request.clientAlertId,
            activatedAt: request.activatedAt,
            hasLocation: request.location !== undefined,
            hasMotionSummary: request.motionSummary !== undefined,
            totalRecipients: recipients.length,
          },
        });
        if (recipients.length === 0) settleInitialNotification(ctx, alertId);
        return { alertId, created: true, recipients: recipients.length };
      });

      if (outcome.created) {
        log.info("SOS received", { alertId: outcome.alertId, totalRecipients: outcome.recipients });
        if (outcome.recipients > 0) {
          ownAlerts.add(outcome.alertId);
          void dispatchInitial(outcome.alertId);
          runContextAnalysis(outcome.alertId, request).catch((error: unknown) =>
            log.error("context analysis failed", {
              alertId: outcome.alertId,
              ...errorFields(error),
            }),
          );
        }
      } else {
        log.info("duplicate SOS request; nothing re-sent", { alertId: outcome.alertId });
      }

      const alert = currentRecord(outcome.alertId);
      if (!alert) throw new Error("alert disappeared after insert");
      return { alert, created: outcome.created };
    },

    async getAlert(alertId) {
      if (!AlertIdSchema.safeParse(alertId).success) return null;
      return currentRecord(alertId);
    },

    async listEvents(alertId, query) {
      if (!AlertIdSchema.safeParse(alertId).success) return null;
      if (!getAlertRow(db, alertId)) return null;
      const events = ctx.events.list(alertId, { cursor: query.cursor ?? null, limit: query.limit });
      const last = events.at(-1);
      return {
        events,
        nextCursor: last ? String(last.id) : (query.cursor ?? null),
        hasMore: events.length === query.limit,
      };
    },
  };
}

/** What the context service sees: the SOS request's sensor data plus factual notes. */
function sensorSnapshot(request: SOSRequest): EmergencySensorSnapshot {
  const location = request.location ?? null;
  const motionSummary = request.motionSummary ?? null;
  const diagnostics: string[] = [];
  if (!location) {
    diagnostics.push("The SOS request did not include a phone location.");
  } else {
    const ageMs = locationAgeMs(location, request.activatedAt);
    if (ageMs > LOCATION_STALE_AFTER_MS) {
      diagnostics.push(
        `The location fix is ${Math.round(ageMs / 1000)} s older than the SOS activation.`,
      );
    }
    if (location.timestampSource === "received") {
      diagnostics.push("The phone did not report the fix time; the time it was received is used.");
    }
  }
  if (!motionSummary) diagnostics.push("The SOS request did not include a G2 motion summary.");
  return EmergencySensorSnapshotSchema.parse({
    // Phone clock, like every other timestamp in the snapshot: the countdown's end.
    capturedAtMs: Math.max(request.activatedAt + SOS_COUNTDOWN_MS, motionSummary?.windowEndMs ?? 0),
    location,
    motionSummary,
    diagnostics,
  });
}
