import { z } from "zod";
import { TimestampMsSchema } from "./common";

/**
 * Hackathon-grade enrollment: the wearer exchanges the server-configured pairing code
 * for a scoped bearer token. This is NOT an audited identity system. There is one
 * wearer per Haven deployment, no user accounts, and no token refresh.
 */
export const SessionScopeSchema = z.enum([
  "contacts:read",
  "contacts:write",
  "alerts:read",
  "alerts:write",
  "audio:write",
]);
export type SessionScope = z.infer<typeof SessionScopeSchema>;

/** Scopes granted to the wearer's G2 session. */
export const WEARER_SESSION_SCOPES: readonly SessionScope[] = SessionScopeSchema.options;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/** `hvn_` + 43 base64url characters (256 random bits). */
export const SESSION_TOKEN_PATTERN = /^hvn_[A-Za-z0-9_-]{43}$/;
export const SessionTokenSchema = z.string().regex(SESSION_TOKEN_PATTERN);

export const CreateSessionRequestSchema = z.strictObject({
  pairingCode: z.string().min(1).max(128),
  /** Free-form label shown in logs, e.g. "Ayaan's G2". */
  deviceLabel: z.string().trim().min(1).max(64).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z.object({
  sessionToken: SessionTokenSchema,
  tokenType: z.literal("Bearer"),
  expiresAt: TimestampMsSchema,
  scopes: z.array(SessionScopeSchema).min(1),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
