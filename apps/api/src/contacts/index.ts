// Owner: Agent 2. Placeholder created by the foundation commit.
// Implement ContactsService against the `contacts` table (see db/migrations.ts).
// Rules: new numbers start `pending`; consent is preserved only while the phone number is
// unchanged; clients can never set consent; at most MAX_EMERGENCY_CONTACTS.
import { NotImplementedError } from "../lib/errors";
import type { ContactsService, ServiceContext } from "../lib/interfaces";

export function createContactsService(_ctx: ServiceContext): ContactsService {
  return {
    async listContacts() {
      throw new NotImplementedError("contacts.listContacts (Agent 2)");
    },
    async replaceContacts() {
      throw new NotImplementedError("contacts.replaceContacts (Agent 2)");
    },
  };
}
