// Row-level access to the `contacts` table, shared by Agent 2's contacts, alerts, and
// photon modules. Consent only changes through setContactConsent, which only the verified
// Photon webhook handler calls.
import {
  EmergencyContactSchema,
  type ContactConsentStatus,
  type EmergencyContact,
} from "@haven/contracts";
import type { Db } from "../db";

export interface ContactRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  phone_number: string;
  enabled: number;
  consent_status: ContactConsentStatus;
  consent_updated_at: number | null;
  photon_user_id: string | null;
  photon_space_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, display_name, phone_number, enabled, consent_status, consent_updated_at,
  photon_user_id, photon_space_id, sort_order, created_at, updated_at`;

export function toEmergencyContact(row: ContactRow): EmergencyContact {
  return EmergencyContactSchema.parse({
    id: row.id,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    enabled: row.enabled === 1,
    consent: { status: row.consent_status, updatedAt: row.consent_updated_at },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Every contact in display order. */
export function listContactRows(db: Db): ContactRow[] {
  return db.all<ContactRow>(
    `SELECT ${COLUMNS} FROM contacts ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
}

export function getContactRow(db: Db, id: string): ContactRow | undefined {
  return db.get<ContactRow>(`SELECT ${COLUMNS} FROM contacts WHERE id = ?`, id);
}

export function findContactByPhone(db: Db, phoneNumber: string): ContactRow | undefined {
  return db.get<ContactRow>(`SELECT ${COLUMNS} FROM contacts WHERE phone_number = ?`, phoneNumber);
}

export function findContactByPhotonSpace(db: Db, spaceId: string): ContactRow | undefined {
  return db.get<ContactRow>(`SELECT ${COLUMNS} FROM contacts WHERE photon_space_id = ?`, spaceId);
}

/** Wearer-enabled contacts who opted in, in display order. */
export function listEligibleContactRows(db: Db): ContactRow[] {
  return db.all<ContactRow>(
    `SELECT ${COLUMNS} FROM contacts WHERE enabled = 1 AND consent_status = 'verified'
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
}

export function isEligibleRow(row: ContactRow): boolean {
  return row.enabled === 1 && row.consent_status === "verified";
}

/** Returns true when the status changed. */
export function setContactConsent(
  db: Db,
  id: string,
  status: ContactConsentStatus,
  now: number,
): boolean {
  const { changes } = db.run(
    `UPDATE contacts SET consent_status = ?, consent_updated_at = ?, updated_at = ?
     WHERE id = ? AND consent_status <> ?`,
    status,
    now,
    now,
    id,
    status,
  );
  return changes === 1;
}

/**
 * Remember the contact's Photon User and Space so later sends skip the lookups. Guarded by
 * the phone number so an identity resolved for an old number never sticks to a new one.
 */
export function cachePhotonIdentity(
  db: Db,
  id: string,
  phoneNumber: string,
  identity: { userId: string | null; spaceId: string | null },
): void {
  db.run(
    `UPDATE contacts SET photon_user_id = ?, photon_space_id = ? WHERE id = ? AND phone_number = ?`,
    identity.userId,
    identity.spaceId,
    id,
    phoneNumber,
  );
}
