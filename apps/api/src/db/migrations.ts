import type { Db } from "./database";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only schema history. Never edit a migration that has been pushed to main;
 * add a new one. Migrations are foundation-owned: feature agents request schema
 * changes through docs/INTEGRATION.md ("Proposing a contract change").
 *
 * Timestamps are INTEGER Unix milliseconds. JSON columns hold contract-shaped data
 * validated with the Zod schemas in @haven/contracts before writing.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      -- Wearer sessions minted from the pairing code. Only the SHA-256 of the token is stored.
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        device_label TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      -- Emergency contacts (Agent 2). Consent changes only from verified Photon webhooks.
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        phone_number TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        consent_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (consent_status IN ('pending', 'verified', 'revoked')),
        consent_updated_at INTEGER,
        photon_user_id TEXT,
        photon_space_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- One row per SOS (Agent 2). client_alert_id makes POST /alerts idempotent.
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        client_alert_id TEXT NOT NULL UNIQUE,
        session_id TEXT REFERENCES sessions (id),
        activated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'received'
          CHECK (state IN ('received', 'notifying', 'notified', 'notification_failed')),
        location_json TEXT,
        motion_summary_json TEXT,
        ai_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (ai_status IN ('pending', 'running', 'completed', 'insufficient_information', 'failed', 'skipped')),
        ai_updated_at INTEGER,
        ai_result_json TEXT
      );

      -- One row per (alert, contact, message kind) (Agent 2). Contact name and number are
      -- snapshotted so later contact edits cannot rewrite who was alerted.
      CREATE TABLE alert_notifications (
        id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES alerts (id),
        contact_id TEXT NOT NULL,
        contact_display_name TEXT NOT NULL,
        contact_phone_number TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('initial_sos', 'context_update', 'recording_link')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'photon_accepted', 'delivery_unconfirmed', 'delivered', 'failed')),
        photon_message_id TEXT UNIQUE,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (alert_id, contact_id, kind)
      );
      CREATE INDEX alert_notifications_alert ON alert_notifications (alert_id, kind);

      -- Append-only alert event log (foundation: db/event-log.ts). AUTOINCREMENT guarantees
      -- IDs are never reused, which keeps cursors monotonic.
      CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL REFERENCES alerts (id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX alert_events_alert_cursor ON alert_events (alert_id, id);

      -- Messages received from contacts through verified Photon webhooks (Agent 2).
      CREATE TABLE inbound_messages (
        photon_message_id TEXT PRIMARY KEY,
        contact_id TEXT,
        alert_id TEXT REFERENCES alerts (id),
        sender_handle TEXT NOT NULL,
        text TEXT,
        received_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Photon webhook event IDs already processed, for at-least-once delivery dedupe (Agent 2).
      CREATE TABLE webhook_receipts (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      -- Emergency audio (Agent 4). id is the client-generated recording UUID.
      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES alerts (id),
        status TEXT NOT NULL DEFAULT 'receiving'
          CHECK (status IN ('receiving', 'finalizing', 'completed', 'failed')),
        mime_type TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        byte_length INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        started_at INTEGER,
        storage_path TEXT,
        sha256 TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX recordings_alert ON recordings (alert_id);

      CREATE TABLE recording_chunks (
        recording_id TEXT NOT NULL REFERENCES recordings (id),
        chunk_index INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (recording_id, chunk_index)
      );

      -- Unguessable recording links for contacts (Agent 4). Only the token hash is stored.
      CREATE TABLE share_links (
        token_hash TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings (id),
        alert_id TEXT NOT NULL REFERENCES alerts (id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER
      );

      -- PHOTON_MODE=mock only (Agent 2): what would have been sent, so demos and tests can
      -- inspect outbound messages without contacting anyone.
      CREATE TABLE mock_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notification_id TEXT,
        kind TEXT NOT NULL,
        to_handle TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

/** Apply pending migrations in order, each in its own transaction. Returns versions applied. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version),
  );
  const ran: number[] = [];
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    ran.push(migration.version);
  }
  return ran;
}
