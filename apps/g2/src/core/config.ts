import { DEFAULT_CLICK_DISAMBIGUATION_MS } from "./input/disambiguator";

export interface G2Config {
  /** Haven API origin + optional path prefix, no trailing slash. */
  apiBaseUrl: string;
  clickDisambiguationMs: number;
}

export const DEFAULT_API_BASE_URL = "http://localhost:8787";

/** Build-time configuration from Vite env (apps/g2/.env.local). Contains no secrets. */
export function loadG2Config(env: Partial<ImportMetaEnv> = import.meta.env): G2Config {
  const raw = env.VITE_HAVEN_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  let apiBaseUrl: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    apiBaseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`VITE_HAVEN_API_BASE_URL is not a valid http(s) URL: ${raw}`);
  }
  return { apiBaseUrl, clickDisambiguationMs: DEFAULT_CLICK_DISAMBIGUATION_MS };
}
