import type { MiddlewareHandler } from "hono";
import {
  SESSION_TOKEN_PATTERN,
  SESSION_TTL_MS,
  SessionScopeSchema,
  WEARER_SESSION_SCOPES,
  type CreateSessionResponse,
  type SessionScope,
} from "@haven/contracts";
import type { Db } from "../db";
import type { Clock } from "./clock";
import { constantTimeEqual, newId, randomToken, sha256Hex } from "./crypto";
import { forbidden, unauthorized } from "./errors";
import type { AppEnv, AuthenticatedSession } from "./hono";

/**
 * Hackathon-grade authentication primitives.
 *
 * - One shared pairing code (HAVEN_PAIRING_CODE) enrolls the wearer's phone.
 * - The code is exchanged for a random 256-bit bearer token; only its SHA-256 is stored.
 * - Tokens carry scopes and expire after SESSION_TTL_MS.
 *
 * Not provided: user accounts, per-device revocation UI, token refresh, or audit logs.
 * See docs/ARCHITECTURE.md § Security model.
 */
export interface SessionService {
  /** Returns null when the pairing code is wrong. */
  exchangePairingCode(pairingCode: string, deviceLabel?: string): CreateSessionResponse | null;
  authenticate(token: string): AuthenticatedSession | null;
  revoke(sessionId: string): void;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  scopes_json: string;
  expires_at: number;
  revoked_at: number | null;
}

export function createSessionService(deps: {
  db: Db;
  clock: Clock;
  pairingCode: string;
  ttlMs?: number;
}): SessionService {
  const ttlMs = deps.ttlMs ?? SESSION_TTL_MS;
  return {
    exchangePairingCode(pairingCode, deviceLabel) {
      if (!constantTimeEqual(pairingCode, deps.pairingCode)) return null;
      const now = deps.clock.now();
      const sessionToken = `hvn_${randomToken(32)}`;
      const scopes = [...WEARER_SESSION_SCOPES];
      deps.db.run(
        `INSERT INTO sessions (id, token_hash, scopes_json, device_label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        newId("ses"),
        sha256Hex(sessionToken),
        JSON.stringify(scopes),
        deviceLabel ?? null,
        now,
        now + ttlMs,
      );
      return { sessionToken, tokenType: "Bearer", expiresAt: now + ttlMs, scopes };
    },
    authenticate(token) {
      if (!SESSION_TOKEN_PATTERN.test(token)) return null;
      const row = deps.db.get<SessionRow>(
        "SELECT id, scopes_json, expires_at, revoked_at FROM sessions WHERE token_hash = ?",
        sha256Hex(token),
      );
      const now = deps.clock.now();
      if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
      deps.db.run("UPDATE sessions SET last_used_at = ? WHERE id = ?", now, row.id);
      const scopes = SessionScopeSchema.array().parse(JSON.parse(row.scopes_json));
      return { sessionId: row.id, scopes, expiresAt: row.expires_at };
    },
    revoke(sessionId) {
      deps.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", deps.clock.now(), sessionId);
    },
  };
}

export interface AuthGuard {
  /** Middleware: requires `Authorization: Bearer <token>` with every listed scope. */
  require(...scopes: SessionScope[]): MiddlewareHandler<AppEnv>;
}

export function createAuthGuard(sessions: SessionService): AuthGuard {
  return {
    require(...scopes) {
      return async (c, next) => {
        const header = c.req.header("authorization") ?? "";
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        const session = match?.[1] ? sessions.authenticate(match[1]) : null;
        if (!session) {
          c.header("WWW-Authenticate", 'Bearer realm="haven"');
          throw unauthorized();
        }
        if (!scopes.every((scope) => session.scopes.includes(scope))) throw forbidden();
        c.set("session", session);
        await next();
      };
    },
  };
}
