// Owner: Agent 2. Emergency contacts on the `contacts` table.
//
// Rules (docs/API_CONTRACTS.md `PUT /contacts`): the list is replaced as a whole; entries
// with an id update that contact, entries without one are added as `pending`, omitted
// contacts are deleted. Consent survives only while the phone number is unchanged, and
// clients can never set it: it changes only through verified Photon webhooks.
import {
  MAX_EMERGENCY_CONTACTS,
  SaveContactsRequestSchema,
  type EmergencyContactInput,
} from "@haven/contracts";
import { newId } from "../lib/crypto";
import { badRequest, type ErrorIssue } from "../lib/errors";
import type { ContactsService, ServiceContext } from "../lib/interfaces";
import { phoneNumberProblem } from "./phone";
import { listContactRows, toEmergencyContact, type ContactRow } from "./repository";

export function createContactsService(ctx: ServiceContext): ContactsService {
  const { db } = ctx;

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
      return listContactRows(db).slice(0, MAX_EMERGENCY_CONTACTS).map(toEmergencyContact);
    },

    async replaceContacts(inputs) {
      const contacts = validate(inputs);
      const now = ctx.clock.now();

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
        for (const id of existing.keys()) {
          if (!kept.has(id)) db.run("DELETE FROM contacts WHERE id = ?", id);
        }
        // Park kept numbers first so swapping two contacts' numbers cannot trip UNIQUE.
        for (const id of kept) {
          db.run("UPDATE contacts SET phone_number = ? WHERE id = ?", `#${id}`, id);
        }

        contacts.forEach((contact, sortOrder) => {
          const previous = contact.id ? existing.get(contact.id) : undefined;
          if (previous) {
            updateContact(previous, contact, sortOrder, now);
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
      return listContactRows(db).map(toEmergencyContact);
    },
  };

  function updateContact(
    previous: ContactRow,
    contact: EmergencyContactInput,
    sortOrder: number,
    now: number,
  ): void {
    const numberChanged = previous.phone_number !== contact.phoneNumber;
    const changed =
      numberChanged ||
      previous.display_name !== contact.displayName ||
      (previous.enabled === 1) !== contact.enabled ||
      previous.sort_order !== sortOrder;
    db.run(
      `UPDATE contacts SET display_name = ?, phone_number = ?, enabled = ?, sort_order = ?,
         consent_status = ?, consent_updated_at = ?, photon_user_id = ?, photon_space_id = ?,
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
      changed ? now : previous.updated_at,
      previous.id,
    );
  }
}
