import type { Context } from "hono";
import type { z } from "zod";
import type { SessionScope } from "@haven/contracts";
import { badRequest, type ErrorIssue } from "./errors";

/** The authenticated wearer session attached by `auth.require(...)`. */
export interface AuthenticatedSession {
  sessionId: string;
  scopes: readonly SessionScope[];
  expiresAt: number;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    session: AuthenticatedSession;
  };
}

export type AppContext = Context<AppEnv>;

function toIssues(error: z.ZodError): ErrorIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

/** Parse and validate a JSON body. Malformed JSON and schema violations become 400s. */
export async function readJson<S extends z.ZodType>(
  c: AppContext,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw badRequest("Request body failed validation", toIssues(parsed.error));
  return parsed.data;
}

/** Validate the query string (single-valued parameters). */
export function readQuery<S extends z.ZodType>(c: AppContext, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Query string failed validation", toIssues(parsed.error));
  return parsed.data;
}

/** Validate a path parameter. */
export function readParam<S extends z.ZodType>(
  c: AppContext,
  name: string,
  schema: S,
): z.output<S> {
  const parsed = schema.safeParse(c.req.param(name));
  if (!parsed.success) throw badRequest(`Invalid path parameter: ${name}`, toIssues(parsed.error));
  return parsed.data;
}
