/**
 * Console logger with a `[haven:<scope>]` prefix. The simulator captures console output
 * (GET /api/console on the automation port), so scripts/sim-smoke.mjs keys off these lines.
 * Never log tokens, phone numbers, coordinates, or audio.
 */
export interface Log {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export const READY_MARKER = "[haven:main] ready";

export function createLog(scope: string): Log {
  const prefix = `[haven:${scope}]`;
  const emit = (fn: (...args: unknown[]) => void, message: string, data?: unknown) =>
    data === undefined ? fn(`${prefix} ${message}`) : fn(`${prefix} ${message}`, data);
  return {
    debug: (m, d) => emit(console.debug, m, d),
    info: (m, d) => emit(console.info, m, d),
    warn: (m, d) => emit(console.warn, m, d),
    error: (m, d) => emit(console.error, m, d),
  };
}

export const silentLog: Log = { debug() {}, info() {}, warn() {}, error() {} };
