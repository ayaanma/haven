// HavenNotificationService over a PhotonTransport (mock or live).
//
// Delivery model:
// - One `alert_notifications` row per (alert, contact, kind). The alert service writes the
//   initial SOS rows in the same transaction as the alert; follow-up rows are written here.
// - A row is sent only while `queued`, always with the stable idempotency key
//   `haven:<alertId>:<contactId>:<kind>`, so a duplicate call or a resend after a lost
//   response never produces a second message. Concurrent calls for a row share one attempt.
// - Contacts are re-checked at send time: a contact who opted out, was disabled or removed,
//   or whose number is blocked is never messaged. Each number has an hourly send limit.
// - Outages, timeouts, and rate limits leave the row `queued` and retry with backoff, bounded
//   by attempts and age. Refusals fail the row at once. One contact's failure never stops
//   the others: every recipient is attempted independently and in parallel.
// - At startup, queued rows left by a previous process are resumed (or expired when too old).
import {
  isAcceptedNotificationStatus,
  type AlertRecord,
  type ContextResult,
  type NotificationKind,
  type NotificationStatus,
} from "@haven/contracts";
import {
  alertContextResult,
  alertLocation,
  applyNotificationStatus,
  ensureNotificationRow,
  getAlertRow,
  getNotificationRow,
  listNotificationRows,
  listQueuedNotificationRows,
  notificationIdempotencyKey,
  type NotificationRow,
} from "../alerts/store";
import { settleInitialNotification } from "../alerts/lifecycle";
import { phoneNumberProblem } from "../contacts/phone";
import { cachePhotonIdentity, getContactRow, isEligibleRow } from "../contacts/repository";
import { notFound } from "../lib/errors";
import type {
  HavenNotificationService,
  NotificationBatchResult,
  NotificationResult,
  ServiceContext,
} from "../lib/interfaces";
import { errorFields } from "../lib/logger";
import { createLivePhotonTransport } from "./live-transport";
import {
  buildContextUpdateMessage,
  buildInitialSosMessage,
  buildRecordingMessage,
} from "./messages";
import { createMockPhotonTransport } from "./mock-transport";
import type { PhotonTransport, ProviderMessageStatus, SendOutcome } from "./transport";

export interface RetryPolicy {
  /** Send attempts per message, including the first. */
  maxAttempts: number;
  /** Delay before attempt `attempt` (≥ 2). */
  delayMs(attempt: number): number;
  /** Rows older than this are not retried again. */
  deadlineMs: number;
}

/** ~90 s of retries over 8 attempts; each attempt also has the client's own HTTP retries. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  delayMs: (attempt) => Math.min(30_000, 1_000 * 2 ** (attempt - 2)),
  deadlineMs: 2 * 60_000,
};

/** Accepted Haven messages per phone number per rolling hour (three per alert at most). */
export const DEFAULT_HOURLY_SEND_LIMIT = 30;

export interface NotificationServiceOptions {
  transport?: PhotonTransport;
  retry?: RetryPolicy;
  hourlySendLimit?: number;
  /** Resume queued rows from a previous process shortly after startup (default true). */
  recoverOnStart?: boolean;
  /** Timer used for retries and startup recovery. */
  schedule?: (callback: () => void, delayMs: number) => void;
}

const defaultSchedule = (callback: () => void, delayMs: number) => {
  setTimeout(callback, delayMs).unref();
};

const STATUS_FOR_PROVIDER: Record<ProviderMessageStatus, NotificationStatus> = {
  dispatched: "photon_accepted",
  accepted: "delivery_unconfirmed",
  delivered: "delivered",
  failed: "failed",
};

export function createPhotonNotificationService(
  ctx: ServiceContext,
  options: NotificationServiceOptions = {},
): HavenNotificationService {
  const { db, logger } = ctx;
  const transport =
    options.transport ??
    (ctx.config.photon.mode === "live"
      ? createLivePhotonTransport(ctx.config)
      : createMockPhotonTransport(ctx));
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  const hourlyLimit = options.hourlySendLimit ?? DEFAULT_HOURLY_SEND_LIMIT;
  const schedule = options.schedule ?? defaultSchedule;
  const log = logger.child({ module: "photon", photonMode: transport.mode });

  /** Rows this process has handled; startup recovery leaves them alone. */
  const attempts = new Map<string, number>();
  const inflight = new Map<string, Promise<NotificationResult>>();
  const pendingRetry = new Set<string>();

  function resultOf(row: NotificationRow, transientCode: string | null = null): NotificationResult {
    return {
      contactId: row.contact_id,
      status: row.status,
      providerMessageId: row.photon_message_id,
      failureCode: row.status === "queued" ? transientCode : row.failure_code,
    };
  }

  function batchOf(kind: NotificationKind, results: NotificationResult[]): NotificationBatchResult {
    return {
      kind,
      totalRecipients: results.length,
      acceptedCount: results.filter((r) => isAcceptedNotificationStatus(r.status)).length,
      failedCount: results.filter((r) => r.status === "failed").length,
      results,
    };
  }

  /** Why this row must not be sent now, or null. */
  function refusalFor(row: NotificationRow): string | null {
    const contact = getContactRow(db, row.contact_id);
    if (!contact || contact.phone_number !== row.contact_phone_number) return "contact_removed";
    if (contact.consent_status === "revoked") return "consent_revoked";
    if (!isEligibleRow(contact)) return "contact_not_eligible";
    if (phoneNumberProblem(row.contact_phone_number)) return "blocked_number";
    const recent = db.get<{ sent: number }>(
      `SELECT COUNT(*) AS sent FROM alert_notifications
       WHERE contact_phone_number = ? AND status NOT IN ('queued', 'failed') AND created_at > ?`,
      row.contact_phone_number,
      ctx.clock.now() - 3_600_000,
    );
    if ((recent?.sent ?? 0) >= hourlyLimit) return "send_limit_exceeded";
    return null;
  }

  function afterChange(row: NotificationRow): void {
    if (row.kind === "initial_sos") settleInitialNotification(ctx, row.alert_id);
  }

  function fail(row: NotificationRow, failureCode: string): void {
    applyNotificationStatus(ctx, row.id, { status: "failed", failureCode });
    attempts.delete(row.id);
    afterChange(row);
  }

  function deliver(rowId: string, text: string): Promise<NotificationResult> {
    const running = inflight.get(rowId);
    if (running) return running;
    const attempt = attemptSend(rowId, text).finally(() => inflight.delete(rowId));
    inflight.set(rowId, attempt);
    return attempt;
  }

  async function attemptSend(rowId: string, text: string): Promise<NotificationResult> {
    const row = getNotificationRow(db, rowId);
    if (!row) throw new Error("notification row disappeared");
    if (row.status !== "queued") return resultOf(row);

    const refusal = refusalFor(row);
    if (refusal) {
      log.warn("notification refused", logFields(row, { failureCode: refusal }));
      fail(row, refusal);
      return resultOf(getNotificationRow(db, rowId) ?? row);
    }

    const attempt = (attempts.get(row.id) ?? 0) + 1;
    attempts.set(row.id, attempt);
    const contact = getContactRow(db, row.contact_id);
    let outcome: SendOutcome;
    try {
      outcome = await transport.send({
        notificationId: row.id,
        kind: row.kind,
        idempotencyKey: notificationIdempotencyKey(row),
        text,
        recipient: {
          contactId: row.contact_id,
          phoneNumber: row.contact_phone_number,
          userId: contact?.photon_user_id ?? null,
          spaceId: contact?.photon_space_id ?? null,
          agentUserId: contact?.photon_agent_user_id ?? null,
        },
      });
    } catch (error) {
      // Transports report failures as outcomes; a throw is a bug, retried like an outage.
      log.error("photon transport threw", { ...logFields(row), ...errorFields(error) });
      outcome = {
        ok: false,
        retryable: true,
        failureCode: "send_error",
        identity: { userId: null, spaceId: null },
      };
    }

    if (
      contact &&
      (outcome.identity.userId !== contact.photon_user_id ||
        outcome.identity.spaceId !== contact.photon_space_id)
    ) {
      cachePhotonIdentity(db, contact.id, row.contact_phone_number, outcome.identity);
    }

    if (outcome.ok) {
      log.info(
        "photon accepted message",
        logFields(row, {
          attempt,
          providerStatus: outcome.providerStatus,
          replayed: outcome.replayed,
        }),
      );
      applyNotificationStatus(ctx, row.id, {
        status: STATUS_FOR_PROVIDER[outcome.providerStatus],
        providerMessageId: outcome.providerMessageId,
        failureCode: outcome.failureCode ?? "message_failed",
      });
      attempts.delete(row.id);
      afterChange(row);
      return resultOf(getNotificationRow(db, rowId) ?? row);
    }

    const tooOld = ctx.clock.now() - row.created_at >= policy.deadlineMs;
    if (!outcome.retryable || attempt >= policy.maxAttempts || tooOld) {
      log.warn(
        "photon send failed",
        logFields(row, { attempt, failureCode: outcome.failureCode, retryable: outcome.retryable }),
      );
      fail(row, outcome.failureCode);
      return resultOf(getNotificationRow(db, rowId) ?? row);
    }

    log.warn(
      "photon send will be retried",
      logFields(row, { attempt, failureCode: outcome.failureCode }),
    );
    scheduleRetry(row.id, text, policy.delayMs(attempt + 1));
    return resultOf(row, outcome.failureCode);
  }

  function scheduleRetry(rowId: string, text: string, delayMs: number): void {
    if (pendingRetry.has(rowId)) return;
    pendingRetry.add(rowId);
    schedule(() => {
      pendingRetry.delete(rowId);
      deliver(rowId, text).catch((error: unknown) =>
        log.error("notification retry failed", { notificationId: rowId, ...errorFields(error) }),
      );
    }, delayMs);
  }

  /** Contacts whose initial SOS Photon accepted and who are still eligible. */
  function followUpRows(alertId: string, kind: NotificationKind): NotificationRow[] {
    const now = ctx.clock.now();
    return listNotificationRows(db, alertId, "initial_sos")
      .filter((initial) => isAcceptedNotificationStatus(initial.status))
      .filter((initial) => {
        const contact = getContactRow(db, initial.contact_id);
        return (
          contact !== undefined &&
          contact.phone_number === initial.contact_phone_number &&
          isEligibleRow(contact)
        );
      })
      .map((initial) =>
        ensureNotificationRow(
          db,
          alertId,
          {
            id: initial.contact_id,
            display_name: initial.contact_display_name,
            phone_number: initial.contact_phone_number,
          },
          kind,
          now,
        ),
      );
  }

  function initialText(alertId: string): string {
    const alert = getAlertRow(db, alertId);
    if (!alert) throw notFound("Alert not found");
    return buildInitialSosMessage({
      wearerName: ctx.config.wearerName,
      activatedAt: alert.activated_at,
      location: alertLocation(alert),
    });
  }

  function recover(): void {
    const now = ctx.clock.now();
    const untouched = (row: NotificationRow) =>
      !attempts.has(row.id) && !inflight.has(row.id) && !pendingRetry.has(row.id);
    const resume = (row: NotificationRow, text: string | null) => {
      if (text === null) return fail(row, "message_unavailable");
      if (now - row.created_at >= policy.deadlineMs) return fail(row, "retry_exhausted");
      deliver(row.id, text).catch((error: unknown) =>
        log.error("notification recovery failed", { ...logFields(row), ...errorFields(error) }),
      );
    };
    for (const row of listQueuedNotificationRows(db, "initial_sos").filter(untouched)) {
      resume(row, initialText(row.alert_id));
    }
    for (const row of listQueuedNotificationRows(db, "context_update").filter(untouched)) {
      const alert = getAlertRow(db, row.alert_id);
      const result = alert ? alertContextResult(alert) : null;
      resume(row, result ? buildContextUpdateMessage(result) : null);
    }
    // recording_link rows need the secure URL, which only Agent 4's caller has. They stay
    // queued and go out on the next sendRecordingNotification call for the alert.
  }

  if (options.recoverOnStart ?? true) {
    schedule(() => {
      try {
        recover();
      } catch (error) {
        log.error("notification recovery failed", errorFields(error));
      }
    }, 0);
  }

  return {
    async sendInitialSOS(alert: AlertRecord) {
      const text = initialText(alert.alertId);
      const existing = new Map(
        listNotificationRows(db, alert.alertId, "initial_sos").map((r) => [r.contact_id, r]),
      );
      const rows = alert.recipients.flatMap((recipient) => {
        const row = existing.get(recipient.contactId);
        if (row) return [row];
        const contact = getContactRow(db, recipient.contactId);
        return contact
          ? [ensureNotificationRow(db, alert.alertId, contact, "initial_sos", ctx.clock.now())]
          : [];
      });
      const results = await Promise.all(rows.map((row) => deliver(row.id, text)));
      return batchOf("initial_sos", results);
    },

    async sendContextUpdate(alertId: string, context: ContextResult) {
      if (!getAlertRow(db, alertId)) throw notFound("Alert not found");
      const text = buildContextUpdateMessage(context);
      if (text === null) return batchOf("context_update", []);
      const rows = followUpRows(alertId, "context_update");
      return batchOf("context_update", await Promise.all(rows.map((row) => deliver(row.id, text))));
    },

    async sendRecordingNotification(alertId: string, secureUrl: string) {
      if (!getAlertRow(db, alertId)) throw notFound("Alert not found");
      assertRecordingUrl(secureUrl, transport.mode);
      const text = buildRecordingMessage(secureUrl);
      const rows = followUpRows(alertId, "recording_link");
      return batchOf("recording_link", await Promise.all(rows.map((row) => deliver(row.id, text))));
    },
  };
}

function logFields(row: NotificationRow, extra: Record<string, unknown> = {}) {
  return {
    notificationId: row.id,
    alertId: row.alert_id,
    contactId: row.contact_id,
    kind: row.kind,
    ...extra,
  };
}

/** Recording links go to people outside Haven: absolute, HTTPS in live mode, one line. */
function assertRecordingUrl(secureUrl: string, mode: "mock" | "live"): void {
  let url: URL;
  try {
    url = new URL(secureUrl);
  } catch {
    throw new Error("Recording link is not a valid URL");
  }
  const allowed = mode === "live" ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(url.protocol) || /\s/.test(secureUrl) || url.username || url.password) {
    throw new Error("Recording link must be an absolute HTTPS URL");
  }
}
