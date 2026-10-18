// Owner: Agent 2. Placeholder created by the foundation commit.
//
// createAlert must, in order:
//   1. Return the existing alert when clientAlertId was seen before (created: false).
//   2. Persist the alert and append `sos.received`.
//   3. Dispatch the initial SOS via deps.notifications.sendInitialSOS IMMEDIATELY.
//      Never await AI analysis first.
//   4. Append `alert.initial_notification_accepted` the first time ≥1 initial message is
//      accepted (this starts recording on the G2), or `alert.initial_notification_failed`.
//   5. Separately run deps.context.analyzeEmergencyContext, then sendContextUpdate.
//      Analysis failure or insufficient information must not affect the SOS.
import { AlertIdSchema } from "@haven/contracts";
import { NotImplementedError } from "../lib/errors";
import type {
  AlertService,
  ContactsService,
  HavenContextService,
  HavenNotificationService,
  ServiceContext,
} from "../lib/interfaces";

export interface AlertServiceDeps {
  contacts: ContactsService;
  notifications: HavenNotificationService;
  context: HavenContextService;
}

export function createAlertService(ctx: ServiceContext, _deps: AlertServiceDeps): AlertService {
  return {
    async createAlert() {
      throw new NotImplementedError("alerts.createAlert (Agent 2)");
    },
    async getAlert() {
      throw new NotImplementedError("alerts.getAlert (Agent 2)");
    },
    // Working default built on the foundation event log. Agent 2 may keep or replace it.
    async listEvents(alertId, query) {
      if (!AlertIdSchema.safeParse(alertId).success) return null;
      const exists = ctx.db.get("SELECT 1 AS found FROM alerts WHERE id = ?", alertId);
      if (!exists) return null;
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
