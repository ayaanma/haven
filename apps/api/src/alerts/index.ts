// Owner: Agent 2. SOS alerts: persistence, idempotency on clientAlertId, the initial
// dispatch (never delayed by AI), lifecycle events, and the AI context follow-up.
// See service.ts for the step-by-step contract and store.ts for the durable outbox.
import type { AlertService, ServiceContext } from "../lib/interfaces";
import { buildAlertService, type AlertServiceDeps } from "./service";

export type { AlertServiceDeps } from "./service";

export function createAlertService(ctx: ServiceContext, deps: AlertServiceDeps): AlertService {
  return buildAlertService(ctx, deps);
}
