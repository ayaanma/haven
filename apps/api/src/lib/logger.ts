export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/**
 * Keys whose values never reach logs. Emergency data is sensitive: log IDs and
 * counts, not phone numbers, coordinates, message text, or audio.
 */
const REDACTED_KEY_PATTERN =
  /authorization|token|secret|api_?key|password|pairing|phone|latitude|longitude/i;
const REDACTED_EXACT_KEYS = new Set(["text", "body", "content", "audio", "location"]);

function isRedactedKey(key: string): boolean {
  return REDACTED_KEY_PATTERN.test(key) || REDACTED_EXACT_KEYS.has(key.toLowerCase());
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isRedactedKey(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-lines logger with key-based redaction. */
export function createLogger(
  options: {
    level?: LogLevel;
    fields?: Record<string, unknown>;
    write?: (line: string) => void;
  } = {},
): Logger {
  const min = LEVEL_ORDER[options.level ?? "info"];
  const base = options.fields ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < min) return;
    const record = { time: new Date().toISOString(), level, message, ...base, ...fields };
    write(JSON.stringify(redact(record)));
  };
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

/** Loggable summary of a thrown value (Error objects serialize to `{}` otherwise). */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorMessage: String(error) };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
