// Foundation-owned: authentication primitives.
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { CreateSessionRequestSchema, ROUTES } from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { rateLimited, unauthorized } from "../lib/errors";
import { readJson, type AppContext, type AppEnv } from "../lib/hono";
import { createRateLimiter } from "../lib/rate-limit";

/** 10 pairing attempts per client address per 5 minutes. */
const PAIRING_ATTEMPTS = { limit: 10, windowMs: 5 * 60_000 };

function clientAddress(c: AppContext): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // app.request() in tests has no socket
  }
}

export function createAuthRoutes(container: ServiceContainer) {
  const limiter = createRateLimiter({ ...PAIRING_ATTEMPTS, clock: container.clock });
  const routes = new Hono<AppEnv>();

  routes.post(ROUTES.createSession, async (c) => {
    const address = clientAddress(c);
    if (!limiter.attempt(address)) throw rateLimited();
    const body = await readJson(c, CreateSessionRequestSchema);
    const session = container.sessions.exchangePairingCode(body.pairingCode, body.deviceLabel);
    if (!session) {
      container.logger.warn("pairing code rejected", { address });
      throw unauthorized("Invalid pairing code");
    }
    limiter.reset(address);
    container.logger.info("session created", { deviceLabel: body.deviceLabel ?? null });
    return c.json(session, 201);
  });

  return routes;
}
