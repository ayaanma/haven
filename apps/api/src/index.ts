// Backend entry point (foundation-owned). `npm run dev:api` from the repo root.
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createContainer } from "./container";
import { migrate, openDatabase } from "./db";
import { ConfigError, describeConfig, loadConfig } from "./lib/config";
import { createLogger, errorFields } from "./lib/logger";

// src/index.ts and dist/index.js both sit three levels below the repo root.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const logger = createLogger({ fields: { service: "haven-api" } });

function main() {
  const config = loadConfig(process.env, repoRoot);
  const db = openDatabase(config.databasePath);
  const applied = migrate(db);
  const container = createContainer(config, { db, logger });
  const app = createApp(container);

  logger.info("configuration loaded", { ...describeConfig(config), migrationsApplied: applied });
  if (config.photon.mode === "mock") {
    logger.info("PHOTON_MODE=mock: no messages will be sent to anyone");
  } else {
    logger.warn("PHOTON_MODE=live: emergency messages will be sent to real contacts");
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info("haven api listening", { url: `http://localhost:${info.port}` });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    logger.error("failed to start", errorFields(error));
  }
  process.exit(1);
}
