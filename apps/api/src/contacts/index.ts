// Owner: Agent 2. Emergency contacts on the `contacts` table.
//
// Rules (docs/API_CONTRACTS.md `PUT /contacts`): the list is replaced as a whole; entries
// with an id update that contact, entries without one are added as `pending`, omitted
// contacts are deleted. Consent survives only while the phone number is unchanged, and
// clients can never set it: it changes only through verified Photon webhooks.
//
// With Photon shared iMessage lines (live mode), each contact also gets their own line
// assignment; its number is the contact's `optInNumber` (see ../photon/lines.ts).
import {
  MAX_EMERGENCY_CONTACTS,
  SaveContactsRequestSchema,
  type EmergencyContactInput,
} from "@haven/contracts";
import { newId } from "../lib/crypto";
import { badRequest, type ErrorIssue } from "../lib/errors";
import type { ContactsService, ServiceContext } from "../lib/interfaces";
import { createLineService, type PhotonLineService } from "../photon/lines";
import { phoneNumberProblem } from "./phone";
import {
  listContactRows,
  saveLineAssignment,
  toEmergencyContact,
  type ContactRow,
} from "./repository";

/** A failed line assignment is retried on a later read, at most this often per contact. */
const ASSIGN_RETRY_MS = 60_000;

export function createContactsService(ctx: ServiceContext): ContactsService {
  return buildContactsService(ctx, createLineService(ctx.config, ctx.logger));
}

export function buildContactsService(
  ctx: ServiceContext,
  lines: PhotonLineService,
): ContactsService {
  const { db } = ctx;
  const sharedLineNumber = ctx.config.photon.lineNumber ?? null;
  const lastAttempt = new Map<string, number>();
  const present = () =>
    listContactRows(db)
      .slice(0, MAX_EMERGENCY_CONTACTS)
      .map((row) => toEmergencyContact(row, sharedLineNumber));

  /** Give every contact without a line its own shared-line assignment (live, shared mode). */
  async function assignMissingLines(force: boolean): Promise<void> {
    if (!lines.perContact) return;
    for (const row of listContactRows(db)) {
      if (row.photon_line_number) continue;
      const now = ctx.clock.now();
      if (!force && now - (lastAttempt.get(row.id) ?? 0) < ASSIGN_RETRY_MS) continue;
      lastAttempt.set(row.id, now);
      const assignment = await lines.assign({ id: row.id, phoneNumber: row.phone_number });
      if (assignment) saveLineAssignment(db, row.id, row.phone_number, assignment);
    }
  }

  function validate(inputs: EmergencyContactInput[]): EmergencyContactInput[] {
    // Routes validate too; this guards direct callers and adds Haven's stricter number rules.
    const parsed = SaveContactsRequestSchema.safeParse({ contacts: inputs });
    if (!parsed.success) {
      throw badRequest(
        "Contacts failed validation",
        parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.map(String).join(".") || "(root)",
          message: issue.message,
        })),
      );
    }
    const issues: ErrorIssue[] = [];
    parsed.data.contacts.forEach((contact, i) => {
      const problem = phoneNumberProblem(contact.phoneNumber);
      if (problem) issues.push({ path: `contacts.${i}.phoneNumber`, message: problem });
    });
    if (issues.length > 0) throw badRequest("Contacts failed validation", issues);
    return parsed.data.contacts;
  }

  return {
    async listContacts() {
      await assignMissingLines(false);
      return present();
    },

    async replaceContacts(inputs) {
      const contacts = validate(inputs);
      const now = ctx.clock.now();
      const released: string[] = [];

      db.transaction(() => {
        const existing = new Map(listContactRows(db).map((row) => [row.id, row]));
        const unknown: ErrorIssue[] = [];
        contacts.forEach((contact, i) => {
          if (contact.id && !existing.has(contact.id)) {
            unknown.push({ path: `contacts.${i}.id`, message: "Unknown contact ID" });
          }
        });
        if (unknown.length > 0) throw badRequest("Contacts failed validation", unknown);

        const kept = new Set(contacts.flatMap((contact) => (contact.id ? [contact.id] : [])));
        for (const [id, row] of existing) {
          if (kept.has(id)) continue;
          db.run("DELETE FROM contacts WHERE id = ?", id);
          if (row.photon_assignment_id) released.push(row.photon_assignment_id);
        }
        // Park kept numbers first so swapping two contacts' numbers cannot trip UNIQUE.
        for (const id of kept) {
          db.run("UPDATE contacts SET phone_number = ? WHERE id = ?", `#${id}`, id);
        }

        contacts.forEach((contact, sortOrder) => {
          const previous = contact.id ? existing.get(contact.id) : undefined;
          if (previous) {
            const oldAssignment = updateContact(previous, contact, sortOrder, now);
            if (oldAssignment) released.push(oldAssignment);
          } else {
            db.run(
              `INSERT INTO contacts (id, display_name, phone_number, enabled, consent_status,
                 consent_updated_at, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
              newId("ctc"),
              contact.displayName,
              contact.phoneNumber,
              contact.enabled ? 1 : 0,
              sortOrder,
              now,
              now,
            );
          }
        });
      });

      ctx.logger.info("contacts replaced", { contactCount: contacts.length });
      for (const assignmentId of released) await lines.release(assignmentId);
      await assignMissingLines(true);
      return present();
    },
  };

  function updateContact(
    previous: ContactRow,
    contact: EmergencyContactInput,
    sortOrder: number,
    now: number,
  ): string | null {
    const numberChanged = previous.phone_number !== contact.phoneNumber;
    const changed =
      numberChanged ||
      previous.display_name !== contact.displayName ||
      (previous.enabled === 1) !== contact.enabled ||
      previous.sort_order !== sortOrder;
    db.run(
      `UPDATE contacts SET display_name = ?, phone_number = ?, enabled = ?, sort_order = ?,
         consent_status = ?, consent_updated_at = ?, photon_user_id = ?, photon_space_id = ?,
         photon_agent_user_id = ?, photon_line_number = ?, photon_assignment_id = ?,
         updated_at = ?
       WHERE id = ?`,
      contact.displayName,
      contact.phoneNumber,
      contact.enabled ? 1 : 0,
      sortOrder,
      // A new number has not opted in, and the old Photon identity belongs to the old number.
      numberChanged ? "pending" : previous.consent_status,
      numberChanged ? now : previous.consent_updated_at,
      numberChanged ? null : previous.photon_user_id,
      numberChanged ? null : previous.photon_space_id,
      numberChanged ? null : previous.photon_agent_user_id,
      numberChanged ? null : previous.photon_line_number,
      numberChanged ? null : previous.photon_assignment_id,
      changed ? now : previous.updated_at,
      previous.id,
    );
    // The old number's line assignment is released once the transaction commits.
    return numberChanged ? previous.photon_assignment_id : null;
  }
}
