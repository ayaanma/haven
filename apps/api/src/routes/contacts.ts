// Owner: Agent 2. Route wiring created by the foundation commit; behavior lives in
// ../contacts. Keep request/response shapes identical to docs/API_CONTRACTS.md.
import { Hono } from "hono";
import { ContactsResponseSchema, ROUTES, SaveContactsRequestSchema } from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { readJson, type AppEnv } from "../lib/hono";

export function createContactRoutes(container: ServiceContainer) {
  const routes = new Hono<AppEnv>();

  routes.get(ROUTES.contacts, container.auth.require("contacts:read"), async (c) => {
    const contacts = await container.contacts.listContacts();
    return c.json(ContactsResponseSchema.parse({ contacts }));
  });

  routes.put(ROUTES.contacts, container.auth.require("contacts:write"), async (c) => {
    const body = await readJson(c, SaveContactsRequestSchema);
    const contacts = await container.contacts.replaceContacts(body.contacts);
    return c.json(ContactsResponseSchema.parse({ contacts }));
  });

  return routes;
}
