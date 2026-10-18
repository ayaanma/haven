import { SessionTokenSchema } from "@haven/contracts";
import { z } from "zod";
import type { HavenBridge } from "./bridge";

/** Async key/value persistence that survives WebView suspension (Android may cold-start the app). */
export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StoredSession {
  token: string;
  expiresAt: number;
}

export interface SessionStore {
  /** The current, unexpired session, or null. */
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

const SESSION_KEY = "haven.session.v1";
const StoredSessionSchema = z.object({
  token: SessionTokenSchema,
  expiresAt: z.number().int().positive(),
});

export function createSessionStore(
  storage: KeyValueStorage,
  now: () => number = Date.now,
): SessionStore {
  let cached: StoredSession | null | undefined;
  return {
    async load() {
      if (cached === undefined) {
        const raw = await storage.get(SESSION_KEY);
        let parsed: StoredSession | null = null;
        if (raw) {
          try {
            const result = StoredSessionSchema.safeParse(JSON.parse(raw));
            parsed = result.success ? result.data : null;
          } catch {
            parsed = null;
          }
        }
        cached = parsed;
      }
      if (cached && cached.expiresAt <= now()) return null;
      return cached;
    },
    async save(session) {
      const valid = StoredSessionSchema.parse(session);
      cached = valid;
      await storage.set(SESSION_KEY, JSON.stringify(valid));
    },
    async clear() {
      cached = null;
      await storage.remove(SESSION_KEY);
    },
  };
}

/**
 * Storage backed by the Even App host (`setLocalStorage`/`getLocalStorage`), mirrored to
 * `window.localStorage` so a value survives if either side is unavailable.
 */
export function createBridgeStorage(
  bridge: Pick<HavenBridge, "getLocalStorage" | "setLocalStorage">,
): KeyValueStorage {
  const web = typeof localStorage === "undefined" ? null : localStorage;
  return {
    async get(key) {
      try {
        const value = await bridge.getLocalStorage(key);
        if (value) return value;
      } catch {
        // fall through to window.localStorage
      }
      return web?.getItem(key) ?? null;
    },
    async set(key, value) {
      web?.setItem(key, value);
      try {
        await bridge.setLocalStorage(key, value);
      } catch {
        // window.localStorage already holds it
      }
    },
    async remove(key) {
      web?.removeItem(key);
      try {
        await bridge.setLocalStorage(key, "");
      } catch {
        // ignore
      }
    },
  };
}

export function createMemoryStorage(): KeyValueStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}
