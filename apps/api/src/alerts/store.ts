// Row-level access to `alerts` and `alert_notifications` (Agent 2), shared by the alert
// service, the Photon notification service, and the Photon webhook handler.
//
// `alert_notifications` is Haven's durable outbox: one row per (alert, contact, kind) is
// written in the same transaction as the alert itself, starts `queued`, and is only ever
// sent with the stable idempotency key `notificationIdempotencyKey(row)`. A restart finds
// still-queued rows and resumes them; Photon's idempotency keys make a resend after a lost
// response a replay, not a second message.
import {
  AlertRecordSchema,
  isAcceptedNotificationStatus,
  type AlertRecord,
  type AlertState,
  type ContextResult,
  type LocationFix,
  type MotionSummary,
  type NotificationKind,
  type NotificationStatus,
  type AiAnalysisStatus,
  type AlertRecordingStatus,
} from "@haven/contracts";
import { randomUUID } from "node:crypto";
import { parseJsonColumn, type Db } from "../db";
import type { ServiceContext } from "../lib/interfaces";
import type { ContactRow } from "../contacts/repository";

export interface AlertRow extends Record<string, unknown> {
  id: string;
  client_alert_id: string;
  session_id: string | null;
  activated_at: number;
  created_at: number;
  updated_at: number;
  state: AlertState;
  location_json: string | null;
  motion_summary_json: string | null;
  ai_status: AiAnalysisStatus;
  ai_updated_at: number | null;
  ai_result_json: string | null;
}

export interface NotificationRow extends Record<string, unknown> {
  id: string;
  alert_id: string;
  contact_id: string;
  contact_display_name: string;
  contact_phone_number: string;
  kind: NotificationKind;
  status: NotificationStatus;
  photon_message_id: string | null;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
}

const ALERT_COLUMNS = `id, client_alert_id, session_id, activated_at, created_at, updated_at,
  state, location_json, motion_summary_json, ai_status, ai_updated_at, ai_result_json`;
const NOTIFICATION_COLUMNS = `id, alert_id, contact_id, contact_display_name, contact_phone_number,
  kind, status, photon_message_id, failure_code, created_at, updated_at`;

// ── alerts ────────────────────────────────────────────────────────────────────

export function getAlertRow(db: Db, alertId: string): AlertRow | undefined {
  return db.get<AlertRow>(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE id = ?`, alertId);
}

export function getAlertRowByClientId(db: Db, clientAlertId: string): AlertRow | undefined {
  return db.get<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM alerts WHERE client_alert_id = ?`,
    clientAlertId,
  );
}

export function alertLocation(row: AlertRow): LocationFix | null {
  return parseJsonColumn<LocationFix>(row.location_json);
}

export function alertMotionSummary(row: AlertRow): MotionSummary | null {
  return parseJsonColumn<MotionSummary>(row.motion_summary_json);
}

export function alertContextResult(row: AlertRow): ContextResult | null {
  return parseJsonColumn<ContextResult>(row.ai_result_json);
}

/** Move `received` → `notifying`. Lifecycle states never move backwards. */
export function markAlertNotifying(db: Db, alertId: string, now: number): void {
  db.run(
    `UPDATE alerts SET state = 'notifying', updated_at = ? WHERE id = ? AND state = 'received'`,
    now,
    alertId,
  );
}

// ── notifications ─────────────────────────────────────────────────────────────

/** Stable Photon `Idempotency-Key` for one Haven message (≤ 255 visible ASCII characters). */
export function notificationIdempotencyKey(
  row: Pick<NotificationRow, "alert_id" | "contact_id" | "kind">,
): string {
  return `haven:${row.alert_id}:${row.contact_id}:${row.kind}`;
}

export function listNotificationRows(
  db: Db,
  alertId: string,
  kind: NotificationKind,
): NotificationRow[] {
  return db.all<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM alert_notifications
     WHERE alert_id = ? AND kind = ? ORDER BY rowid ASC`,
    alertId,
    kind,
  );
}

export function getNotificationRow(db: Db, id: string): NotificationRow | undefined {
  return db.get<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM alert_notifications WHERE id = ?`,
    id,
  );
}

export function findNotificationByPhotonMessageId(
  db: Db,
  photonMessageId: string,
): NotificationRow | undefined {
  return db.get<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM alert_notifications WHERE photon_message_id = ?`,
    photonMessageId,
  );
}

/** Every queued row of `kind`, oldest first (the outbox backlog). */
export function listQueuedNotificationRows(db: Db, kind: NotificationKind): NotificationRow[] {
  return db.all<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM alert_notifications
     WHERE kind = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC`,
    kind,
  );
}

/**
 * Insert the queued row for (alert, contact, kind) unless it exists, snapshotting the
 * contact's name and number, and return the stored row.
 */
export function ensureNotificationRow(
  db: Db,
  alertId: string,
  contact: Pick<ContactRow, "id" | "display_name" | "phone_number">,
  kind: NotificationKind,
  now: number,
): NotificationRow {
  db.run(
    `INSERT INTO alert_notifications (id, alert_id, contact_id, contact_display_name,
       contact_phone_number, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT (alert_id, contact_id, kind) DO NOTHING`,
    `ntf_${randomUUID()}`,
    alertId,
    contact.id,
    contact.display_name,
    contact.phone_number,
    kind,
    now,
    now,
  );
  const row = db.get<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM alert_notifications
     WHERE alert_id = ? AND contact_id = ? AND kind = ?`,
    alertId,
    contact.id,
    kind,
  );
  if (!row) throw new Error("alert_notifications insert failed");
  return row;
}

/**
 * Status order. Photon's terminal statuses (`accepted` → delivery_unconfirmed, `delivered`,
 * `failed`) never change once reached, except that a late delivery confirmation may upgrade
 * delivery_unconfirmed. Out-of-order webhooks therefore cannot move a status backwards.
 */
export function canTransition(from: NotificationStatus, to: NotificationStatus): boolean {
  if (from === to) return false;
  switch (from) {
    case "queued":
      return to !== "queued";
    case "photon_accepted":
      return to === "delivery_unconfirmed" || to === "delivered" || to === "failed";
    case "delivery_unconfirmed":
      return to === "delivered";
    case "delivered":
    case "failed":
      return false;
  }
}

const NOTIFICATION_EVENT_TYPES = {
  photon_accepted: "notification.photon_accepted",
  delivery_unconfirmed: "notification.delivery_unconfirmed",
  delivered: "notification.delivered",
  failed: "notification.failed",
} as const;

export interface StatusUpdate {
  status: NotificationStatus;
  /** Set only when known; never overwrites an existing ID. */
  providerMessageId?: string | null;
  failureCode?: string | null;
}

/**
 * Apply a status change to one notification row and append the matching
 * `notification.*` event. A jump from `queued` straight to a delivery status first records
 * `photon_accepted`, because Photon taking the message is itself a fact the HUD reports.
 * Returns true when anything changed.
 */
export function applyNotificationStatus(
  ctx: ServiceContext,
  rowId: string,
  update: StatusUpdate,
): boolean {
  return ctx.db.transaction(() => {
    const row = getNotificationRow(ctx.db, rowId);
    if (!row) return false;
    const steps: NotificationStatus[] =
      row.status === "queued" &&
      (update.status === "delivery_unconfirmed" || update.status === "delivered")
        ? ["photon_accepted", update.status]
        : [update.status];
    let current = row.status;
    let changed = false;
    for (const status of steps) {
      if (status === "queued" || !canTransition(current, status)) continue;
      const now = ctx.clock.now();
      const failureCode = status === "failed" ? truncateCode(update.failureCode) : null;
      ctx.db.run(
        `UPDATE alert_notifications
         SET status = ?, failure_code = ?, updated_at = ?,
             photon_message_id = COALESCE(photon_message_id, ?)
         WHERE id = ?`,
        status,
        failureCode,
        now,
        update.providerMessageId ?? null,
        row.id,
      );
      ctx.events.append(row.alert_id, {
        type: NOTIFICATION_EVENT_TYPES[status],
        payload: {
          kind: row.kind,
          contactId: row.contact_id,
          displayName: row.contact_display_name,
          status,
          failureCode,
        },
      });
      current = status;
      changed = true;
    }
    return changed;
  });
}

function truncateCode(code: string | null | undefined): string {
  const value = (code ?? "").replace(/[^\w.:-]/g, "_").slice(0, 64);
  return value.length > 0 ? value : "failed";
}

// ── AlertRecord ───────────────────────────────────────────────────────────────

interface RecordingRow extends Record<string, unknown> {
  id: string;
  status: Exclude<AlertRecordingStatus, "not_started">;
  duration_ms: number | null;
}

export function buildAlertRecord(ctx: ServiceContext, row: AlertRow): AlertRecord {
  const initial = listNotificationRows(ctx.db, row.id, "initial_sos");
  const recordingLinks = listNotificationRows(ctx.db, row.id, "recording_link");
  // The recordings table is Agent 4's; it is read here (never written) because AlertRecord
  // reports the recording state and no interface exposes it yet.
  // CONTRACT-PROPOSAL: add `getRecordingForAlert(alertId)` to HavenRecordingStorage.
  const recording = ctx.db.get<RecordingRow>(
    `SELECT id, status, duration_ms FROM recordings WHERE alert_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    row.id,
  );
  const accepted = (r: NotificationRow) => isAcceptedNotificationStatus(r.status);

  return AlertRecordSchema.parse({
    alertId: row.id,
    clientAlertId: row.client_alert_id,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
    location: alertLocation(row),
    recipients: initial.map((r) => ({
      contactId: r.contact_id,
      displayName: r.contact_display_name,
      status: r.status,
      updatedAt: r.updated_at,
      failureCode: r.failure_code,
    })),
    initialAcceptedCount: initial.filter(accepted).length,
    initialDeliveredCount: initial.filter((r) => r.status === "delivered").length,
    totalRecipients: initial.length,
    aiAnalysis: { status: row.ai_status, updatedAt: row.ai_updated_at },
    recording: {
      status: recording?.status ?? "not_started",
      recordingId: recording?.id ?? null,
      durationMs: recording?.duration_ms ?? null,
      notificationAcceptedCount: recordingLinks.filter(accepted).length,
    },
    latestEventCursor: ctx.events.latestCursor(row.id),
  });
}
