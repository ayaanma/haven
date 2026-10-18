// HTTP application (foundation-owned): middleware, error envelope, route registration.
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { ROUTES, type ApiErrorBody, type HealthResponse } from "@haven/contracts";
import type { ServiceContainer } from "./container";
import { HttpError } from "./lib/errors";
import type { AppEnv } from "./lib/hono";
import { errorFields } from "./lib/logger";
import { createAlertRoutes } from "./routes/alerts";
import { createAudioRoutes } from "./routes/audio";
import { createAuthRoutes } from "./routes/auth";
import { createContactRoutes } from "./routes/contacts";
import { createPhotonWebhookRoutes } from "./routes/photon-webhooks";

/** JSON request bodies are small; audio chunks and webhooks set their own limits. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

function jsonBodyLimit(): MiddlewareHandler<AppEnv> {
  const limit = bodyLimit({
    maxSize: MAX_JSON_BODY_BYTES,
    onError: () => {
      throw new HttpError(413, "payload_too_large", "Request body too large");
    },
  });
  return async (c, next) => {
    const path = c.req.path;
    if (path.endsWith("/audio/chunks") || path === ROUTES.photonWebhooks) return next();
    return limit(c, next);
  };
}

export function createApp(container: ServiceContainer): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { config, logger } = container;

  app.use("*", requestId());
  app.use(
    "*",
    cors({
      origin: config.allowedOrigins,
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["X-Request-Id"],
      maxAge: 86_400,
    }),
  );
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  app.use("/api/*", jsonBodyLimit());

  app.get(ROUTES.health, (c) =>
    c.json({
      status: "ok",
      photonMode: config.photon.mode,
      llmMode: config.llm.mode,
    } satisfies HealthResponse),
  );

  app.route("/", createAuthRoutes(container));
  app.route("/", createContactRoutes(container));
  app.route("/", createAlertRoutes(container));
  app.route("/", createAudioRoutes(container));
  app.route("/", createPhotonWebhookRoutes(container));

  app.notFound((c) =>
    c.json(
      {
        error: { code: "not_found", message: "Route not found", requestId: c.get("requestId") },
      } satisfies ApiErrorBody,
      404,
    ),
  );

  app.onError((error, c) => {
    const id = c.get("requestId") ?? "unknown";
    if (error instanceof HttpError) {
      if (error.status === 401) c.header("WWW-Authenticate", 'Bearer realm="haven"');
      if (error.status === 501) {
        logger.debug("placeholder reached", { requestId: id, ...errorFields(error) });
      } else if (error.status >= 500) {
        logger.error("request failed", { requestId: id, ...errorFields(error) });
      }
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          requestId: id,
          ...(error.issues ? { issues: error.issues } : {}),
        },
      };
      return c.json(body, error.status);
    }
    if (error instanceof HTTPException && error.status < 500) {
      return c.json(
        {
          error: { code: "invalid_request", message: error.message, requestId: id },
        } satisfies ApiErrorBody,
        error.status,
      );
    }
    logger.error("unhandled error", { requestId: id, path: c.req.path, ...errorFields(error) });
    return c.json(
      {
        error: { code: "internal_error", message: "Internal server error", requestId: id },
      } satisfies ApiErrorBody,
      500,
    );
  });

  return app;
}
