import {
  AlertEventBodySchema,
  AlertEventSchema,
  type AlertEvent,
  type AlertEventBody,
  type EventCursor,
} from "@haven/contracts";
import type { Clock } from "../lib/clock";
import type { Db } from "./database";

/**
 * The append-only alert event log shared by every backend feature. Each append is
 * validated against the contract, so a producer cannot emit an event type or payload
 * that the G2 app does not understand.
 */
export interface EventLog {
  append(alertId: string, body: AlertEventBody): AlertEvent;
  /** Events for one alert strictly after `cursor`, oldest first. */
  list(alertId: string, options?: { cursor?: EventCursor | null; limit?: number }): AlertEvent[];
  latestCursor(alertId: string): EventCursor | null;
}

interface EventRow extends Record<string, unknown> {
  id: number;
  alert_id: string;
  type: string;
  payload_json: string;
  created_at: number;
}

function toEvent(row: EventRow): AlertEvent {
  return AlertEventSchema.parse({
    id: row.id,
    alertId: row.alert_id,
    timestampMs: row.created_at,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}

export function createEventLog(db: Db, clock: Clock): EventLog {
  return {
    append(alertId, body) {
      const valid = AlertEventBodySchema.parse(body);
      const createdAt = clock.now();
      const { lastInsertRowid } = db.run(
        "INSERT INTO alert_events (alert_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
        alertId,
        valid.type,
        JSON.stringify(valid.payload),
        createdAt,
      );
      return AlertEventSchema.parse({
        id: lastInsertRowid,
        alertId,
        timestampMs: createdAt,
        ...valid,
      });
    },
    list(alertId, options = {}) {
      const after = options.cursor ? Number(options.cursor) : 0;
      const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
      return db
        .all<EventRow>(
          `SELECT id, alert_id, type, payload_json, created_at FROM alert_events
           WHERE alert_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
          alertId,
          after,
          limit,
        )
        .map(toEvent);
    },
    latestCursor(alertId) {
      const row = db.get<{ id: number | null }>(
        "SELECT MAX(id) AS id FROM alert_events WHERE alert_id = ?",
        alertId,
      );
      return row?.id ? String(row.id) : null;
    },
  };
}
