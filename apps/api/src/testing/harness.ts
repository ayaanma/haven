// Shared backend test infrastructure (foundation-owned). Every agent's API tests should
// start from createTestHarness() so they run against the real app, routes, auth, and an
// in-memory SQLite database with the production schema.
import type { Hono } from "hono";
import { createApp } from "../app";
import { createContainer, type ServiceContainer, type ServiceOverrides } from "../container";
import { migrate, openDatabase, type Db } from "../db";
import type { Clock } from "../lib/clock";
import { loadConfig, type HavenConfig } from "../lib/config";
import type { AppEnv } from "../lib/hono";
import { silentLogger } from "../lib/logger";

export const TEST_PAIRING_CODE = "test-pairing-code-123";

/** Manually advanced clock. */
export class FakeClock implements Clock {
  constructor(private current = Date.UTC(2026, 9, 18, 19, 30, 0)) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

/** Config for tests: mock integrations, in-memory paths, no environment leakage. */
export function testConfig(env: Record<string, string> = {}): HavenConfig {
  return loadConfig(
    {
      HAVEN_PAIRING_CODE: TEST_PAIRING_CODE,
      DATABASE_PATH: ":memory:",
      AUDIO_STORAGE_PATH: "./data/test-recordings",
      ...env,
    },
    process.cwd(),
  );
}

export interface TestHarness {
  app: Hono<AppEnv>;
  container: ServiceContainer;
  db: Db;
  clock: FakeClock;
  /** A valid wearer session token with every scope. */
  token: string;
  /** `app.request` without auth. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** `app.request` with `Authorization: Bearer <token>`. */
  authed(path: string, init?: RequestInit): Promise<Response>;
  /** JSON request helper with auth. */
  json(method: string, path: string, body?: unknown): Promise<Response>;
  close(): void;
}

export function createTestHarness(
  options: { env?: Record<string, string>; overrides?: ServiceOverrides; clock?: FakeClock } = {},
): TestHarness {
  const clock = options.clock ?? new FakeClock();
  const config = testConfig(options.env);
  const db = openDatabase(":memory:");
  migrate(db);
  const container = createContainer(config, {
    db,
    clock,
    logger: silentLogger,
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
  const app = createApp(container);
  const session = container.sessions.exchangePairingCode(TEST_PAIRING_CODE, "vitest");
  if (!session) throw new Error("test pairing failed");
  const token = session.sessionToken;

  const request = async (path: string, init?: RequestInit) => app.request(path, init);
  const authed = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return app.request(path, { ...init, headers });
  };

  return {
    app,
    container,
    db,
    clock,
    token,
    request,
    authed,
    json: (method, path, body) =>
      authed(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: () => db.close(),
  };
}
