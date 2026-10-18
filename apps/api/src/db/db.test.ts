import { describe, expect, it } from "vitest";
import { fixtureUuid } from "@haven/contracts/testing";
import type { AlertEventBody } from "@haven/contracts";
import { FakeClock, seedAlert } from "../testing";
import { createEventLog, MIGRATIONS, migrate, openDatabase } from ".";

const started = (n: number): AlertEventBody => ({
  type: "recording.started",
  payload: { recordingId: fixtureUuid(n) },
});

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock();
  return { db, clock, events: createEventLog(db, clock) };
}

describe("migrations", () => {
  it("applies once and is idempotent", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    for (const table of [
      "sessions",
      "contacts",
      "alerts",
      "alert_notifications",
      "alert_events",
      "inbound_messages",
      "webhook_receipts",
      "recordings",
      "recording_chunks",
      "share_links",
      "mock_outbox",
    ]) {
      expect(tables).toContain(table);
    }
  });

  it("enforces foreign keys and check constraints", () => {
    const { db } = setup();
    expect(() =>
      db.run(
        "INSERT INTO alert_events (alert_id, type, payload_json, created_at) VALUES ('missing', 't', '{}', 1)",
      ),
    ).toThrow();
    expect(() => seedAlert(db, { state: "help_is_coming" as never })).toThrow();
  });

  it("rejects duplicate clientAlertId (SOS idempotency backstop)", () => {
    const { db } = setup();
    seedAlert(db, { clientAlertId: fixtureUuid(5) });
    expect(() => seedAlert(db, { clientAlertId: fixtureUuid(5) })).toThrow();
  });
});

describe("transactions", () => {
  it("rolls back on error and supports nesting", () => {
    const { db } = setup();
    expect(() =>
      db.transaction(() => {
        seedAlert(db);
        db.transaction(() => seedAlert(db));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts")?.n).toBe(0);
  });
});

describe("event log", () => {
  it("assigns strictly increasing IDs across alerts", () => {
    const { db, events } = setup();
    const a = seedAlert(db);
    const b = seedAlert(db);
    const ids = [
      events.append(a, started(1)),
      events.append(b, started(2)),
      events.append(a, started(3)),
    ].map((e) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(3);
  });

  it("pages by cursor without gaps or repeats", () => {
    const { db, events } = setup();
    const alertId = seedAlert(db);
    for (let i = 1; i <= 7; i++) events.append(alertId, started(i));

    const seen: number[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = events.list(alertId, { cursor, limit: 3 });
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.id));
      cursor = String(page.at(-1)!.id);
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(events.latestCursor(alertId)).toBe(String(seen.at(-1)));
  });

  it("only returns events for the requested alert", () => {
    const { db, events } = setup();
    const a = seedAlert(db);
    const b = seedAlert(db);
    events.append(a, started(1));
    events.append(b, started(2));
    expect(events.list(a).map((e) => e.alertId)).toEqual([a]);
    expect(events.latestCursor(seedAlert(db))).toBeNull();
  });

  it("stamps server time and rejects payloads that violate the contract", () => {
    const { db, events, clock } = setup();
    const alertId = seedAlert(db);
    clock.set(1_234);
    expect(events.append(alertId, started(1)).timestampMs).toBe(1_234);
    expect(() =>
      events.append(alertId, {
        type: "contact.responded",
        payload: { text: "fabricated" },
      } as unknown as AlertEventBody),
    ).toThrow();
  });
});
