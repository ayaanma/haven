// Owner: Agent 2. Route wiring created by the foundation commit; behavior lives in
// ../alerts. Keep request/response shapes identical to docs/API_CONTRACTS.md.
import { Hono } from "hono";
import {
  AlertEventsPageSchema,
  AlertIdSchema,
  AlertRecordSchema,
  CreateAlertResponseSchema,
  GetAlertEventsQuerySchema,
  ROUTES,
  SOSRequestSchema,
} from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { notFound } from "../lib/errors";
import { readJson, readParam, readQuery, type AppEnv } from "../lib/hono";

export function createAlertRoutes(container: ServiceContainer) {
  const routes = new Hono<AppEnv>();

  routes.post(ROUTES.alerts, container.auth.require("alerts:write"), async (c) => {
    const request = await readJson(c, SOSRequestSchema);
    const result = await container.alerts.createAlert(request, c.get("session").sessionId);
    return c.json(CreateAlertResponseSchema.parse(result), result.created ? 201 : 200);
  });

  routes.get(ROUTES.alert, container.auth.require("alerts:read"), async (c) => {
    const alertId = readParam(c, "alertId", AlertIdSchema);
    const alert = await container.alerts.getAlert(alertId);
    if (!alert) throw notFound("Alert not found");
    return c.json(AlertRecordSchema.parse(alert));
  });

  routes.get(ROUTES.alertEvents, container.auth.require("alerts:read"), async (c) => {
    const alertId = readParam(c, "alertId", AlertIdSchema);
    const query = readQuery(c, GetAlertEventsQuerySchema);
    const page = await container.alerts.listEvents(alertId, query);
    if (!page) throw notFound("Alert not found");
    return c.json(AlertEventsPageSchema.parse(page));
  });

  return routes;
}
