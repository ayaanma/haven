// Owner: Agent 2. Route wiring created by the foundation commit; verification and
// processing live in ../photon. The handler receives the exact raw body for signature checks.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ROUTES } from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { HttpError } from "../lib/errors";
import type { AppEnv } from "../lib/hono";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export function createPhotonWebhookRoutes(container: ServiceContainer) {
  const routes = new Hono<AppEnv>();

  routes.post(
    ROUTES.photonWebhooks,
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: () => {
        throw new HttpError(413, "payload_too_large", "Webhook payload too large");
      },
    }),
    async (c) => {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const result = await container.photonWebhooks.handle({
        rawBody: await c.req.text(),
        headers,
      });
      return c.json(result, 200);
    },
  );

  return routes;
}
