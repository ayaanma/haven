// Alert lifecycle transitions (Agent 2): received → notifying → notified | notification_failed.
//
// settleInitialNotification is idempotent and is called after anything that can change an
// initial SOS row: a send result, a retry, an expiry, or a Photon status webhook. It appends
// `alert.initial_notification_accepted` exactly once, the first time at least one initial
// message is accepted (the G2 app starts recording on it), and
// `alert.initial_notification_failed` exactly once when no initial message can go out.
import { isAcceptedNotificationStatus } from "@haven/contracts";
import type { ServiceContext } from "../lib/interfaces";
import { getAlertRow, listNotificationRows } from "./store";

/**
 * Failure codes that mean Photon (or the network to it) was unavailable rather than that
 * the message itself was refused. When every initial message failed with one of these, the
 * alert fails with reason `provider_unavailable` instead of `all_sends_failed`.
 */
export const PROVIDER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "provider_unavailable",
  "provider_unreachable",
  "provider_timeout",
  "provider_rate_limited",
  "provider_response_invalid",
  "retry_exhausted",
]);

export function settleInitialNotification(ctx: ServiceContext, alertId: string): void {
  ctx.db.transaction(() => {
    const alert = getAlertRow(ctx.db, alertId);
    if (!alert || (alert.state !== "received" && alert.state !== "notifying")) return;

    const rows = listNotificationRows(ctx.db, alertId, "initial_sos");
    const totalRecipients = rows.length;
    const acceptedCount = rows.filter((row) => isAcceptedNotificationStatus(row.status)).length;
    const now = ctx.clock.now();

    if (acceptedCount > 0) {
      transition(ctx, alertId, "notified", now);
      ctx.events.append(alertId, {
        type: "alert.initial_notification_accepted",
        payload: { acceptedCount, totalRecipients },
      });
      return;
    }
    if (rows.some((row) => row.status === "queued")) return;

    const reason =
      totalRecipients === 0
        ? "no_eligible_contacts"
        : rows.every((row) => PROVIDER_UNAVAILABLE_CODES.has(row.failure_code ?? ""))
          ? "provider_unavailable"
          : "all_sends_failed";
    transition(ctx, alertId, "notification_failed", now);
    ctx.events.append(alertId, {
      type: "alert.initial_notification_failed",
      payload: { reason, totalRecipients },
    });
  });
}

function transition(
  ctx: ServiceContext,
  alertId: string,
  state: "notified" | "notification_failed",
  now: number,
): void {
  ctx.db.run(
    `UPDATE alerts SET state = ?, updated_at = ?
     WHERE id = ? AND state IN ('received', 'notifying')`,
    state,
    now,
    alertId,
  );
}
