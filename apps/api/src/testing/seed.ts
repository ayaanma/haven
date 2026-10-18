// Direct row inserts for tests that need existing data owned by another module
// (e.g. Agent 4's audio tests need an alert row before Agent 2's alert service exists).
import { fixtureUuid } from "@haven/contracts/testing";
import type { Db } from "../db";
import { newId } from "../lib/crypto";

export function seedContact(
  db: Db,
  values: Partial<{
    id: string;
    displayName: string;
    phoneNumber: string;
    enabled: boolean;
    consentStatus: "pending" | "verified" | "revoked";
    now: number;
  }> = {},
): string {
  const id = values.id ?? newId("ctc");
  const now = values.now ?? Date.now();
  db.run(
    `INSERT INTO contacts (id, display_name, phone_number, enabled, consent_status,
       consent_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    values.displayName ?? "Mom",
    values.phoneNumber ?? "+14155550123",
    values.enabled === false ? 0 : 1,
    values.consentStatus ?? "verified",
    now,
    now,
    now,
  );
  return id;
}

export function seedAlert(
  db: Db,
  values: Partial<{
    id: string;
    clientAlertId: string;
    state: "received" | "notifying" | "notified" | "notification_failed";
    now: number;
  }> = {},
): string {
  const id = values.id ?? newId("alt");
  const now = values.now ?? Date.now();
  db.run(
    `INSERT INTO alerts (id, client_alert_id, activated_at, created_at, updated_at, state)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    values.clientAlertId ?? fixtureUuid(Math.floor(Math.random() * 1e9)),
    now - 5_000,
    now,
    now,
    values.state ?? "notified",
  );
  return id;
}
