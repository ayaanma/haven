import path from "node:path";
import { z } from "zod";
import { HAVEN_LLM_MODEL } from "@haven/contracts";

/** The pairing code shipped in .env.example. Live mode refuses to run with it. */
export const EXAMPLE_PAIRING_CODE = "change-me-pairing-code";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    DATABASE_PATH: z.string().min(1).default("./data/haven.db"),
    AUDIO_STORAGE_PATH: z.string().min(1).default("./data/recordings"),
    PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
    ALLOWED_ORIGINS: z.string().default("*"),
    HAVEN_PAIRING_CODE: z
      .string({ error: "HAVEN_PAIRING_CODE is required (see .env.example)" })
      .min(8, { error: "HAVEN_PAIRING_CODE must be at least 8 characters" })
      .max(128),
    PHOTON_MODE: z.enum(["mock", "live"]).default("mock"),
    PHOTON_API_KEY: optionalString,
    PHOTON_PROJECT_ID: optionalString,
    PHOTON_AGENT_USER_ID: optionalString,
    PHOTON_PLATFORM: z.enum(["imessage", "sms"]).default("imessage"),
    PHOTON_WEBHOOK_SECRET: optionalString,
    LLM_MODE: z.enum(["mock", "live"]).default("mock"),
    LLM_BASE_URL: z.url().default("https://generativelanguage.googleapis.com/v1beta/openai"),
    LLM_API_KEY: optionalString,
    LLM_MODEL: z
      .literal(HAVEN_LLM_MODEL, {
        error: `LLM_MODEL must be "${HAVEN_LLM_MODEL}". Haven does not support other models.`,
      })
      .default(HAVEN_LLM_MODEL),
  })
  .superRefine((env, ctx) => {
    const issue = (pathName: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [pathName], message });

    if (env.PHOTON_MODE === "live") {
      if (!env.PHOTON_API_KEY?.startsWith("pho_sk_")) {
        issue("PHOTON_API_KEY", "Live mode needs a Photon project API key (pho_sk_...)");
      }
      if (!env.PHOTON_PROJECT_ID || !/^pho_prj_[0-9a-z]{26}$/.test(env.PHOTON_PROJECT_ID)) {
        issue("PHOTON_PROJECT_ID", "Live mode needs a Photon project ID (pho_prj_...)");
      }
      if (!env.PHOTON_AGENT_USER_ID || !/^pho_usr_[0-9a-z]{26}$/.test(env.PHOTON_AGENT_USER_ID)) {
        issue(
          "PHOTON_AGENT_USER_ID",
          "Live mode needs the agent line's Photon User ID (pho_usr_...)",
        );
      }
      if (!env.PHOTON_WEBHOOK_SECRET?.startsWith("whsec_")) {
        issue("PHOTON_WEBHOOK_SECRET", "Live mode needs the webhook signing secret (whsec_...)");
      }
      if (!env.PUBLIC_BASE_URL.startsWith("https://")) {
        issue("PUBLIC_BASE_URL", "Live mode needs an HTTPS PUBLIC_BASE_URL for recording links");
      }
      if (env.HAVEN_PAIRING_CODE === EXAMPLE_PAIRING_CODE || env.HAVEN_PAIRING_CODE.length < 12) {
        issue(
          "HAVEN_PAIRING_CODE",
          "Live mode needs a unique pairing code of at least 12 characters",
        );
      }
    }
    if (env.LLM_MODE === "live" && !env.LLM_API_KEY) {
      issue("LLM_API_KEY", "LLM_MODE=live needs LLM_API_KEY");
    }
  });

export interface HavenConfig {
  port: number;
  databasePath: string;
  audioStoragePath: string;
  /** No trailing slash. */
  publicBaseUrl: string;
  allowedOrigins: "*" | string[];
  pairingCode: string;
  photon: {
    mode: "mock" | "live";
    apiKey: string | undefined;
    projectId: string | undefined;
    agentUserId: string | undefined;
    platform: "imessage" | "sms";
    webhookSecret: string | undefined;
  };
  llm: {
    mode: "mock" | "live";
    baseUrl: string;
    apiKey: string | undefined;
    model: typeof HAVEN_LLM_MODEL;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid Haven configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parse environment variables into a typed config. Relative paths resolve against
 * `baseDir` (the repo root when started via npm scripts), except `:memory:`.
 */
export function loadConfig(env: Record<string, string | undefined>, baseDir: string): HavenConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const resolvePath = (p: string) => (p === ":memory:" ? p : path.resolve(baseDir, p));
  const origins = e.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    port: e.PORT,
    databasePath: resolvePath(e.DATABASE_PATH),
    audioStoragePath: resolvePath(e.AUDIO_STORAGE_PATH),
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    allowedOrigins: origins.length === 0 || origins.includes("*") ? "*" : origins,
    pairingCode: e.HAVEN_PAIRING_CODE,
    photon: {
      mode: e.PHOTON_MODE,
      apiKey: e.PHOTON_API_KEY,
      projectId: e.PHOTON_PROJECT_ID,
      agentUserId: e.PHOTON_AGENT_USER_ID,
      platform: e.PHOTON_PLATFORM,
      webhookSecret: e.PHOTON_WEBHOOK_SECRET,
    },
    llm: {
      mode: e.LLM_MODE,
      baseUrl: e.LLM_BASE_URL.replace(/\/+$/, ""),
      apiKey: e.LLM_API_KEY,
      model: e.LLM_MODEL,
    },
  };
}

/** Config summary that is safe to log: secrets are reduced to presence flags. */
export function describeConfig(config: HavenConfig): Record<string, unknown> {
  return {
    port: config.port,
    databasePath: config.databasePath,
    audioStoragePath: config.audioStoragePath,
    publicBaseUrl: config.publicBaseUrl,
    allowedOrigins: config.allowedOrigins,
    photon: {
      mode: config.photon.mode,
      platform: config.photon.platform,
      projectId: config.photon.projectId ?? null,
      credentialsConfigured: Boolean(config.photon.apiKey && config.photon.agentUserId),
      webhookSigningConfigured: Boolean(config.photon.webhookSecret),
    },
    llm: {
      mode: config.llm.mode,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      credentialsConfigured: Boolean(config.llm.apiKey),
    },
  };
}
