import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, EXAMPLE_PAIRING_CODE, describeConfig, loadConfig } from "./config";

/** 10 characters: valid for mock mode, too short for live mode. */
const base = { HAVEN_PAIRING_CODE: "dev-code-1" };
const live = {
  HAVEN_PAIRING_CODE: "a-long-unique-pairing-code",
  PHOTON_MODE: "live",
  PHOTON_API_KEY: "pho_sk_example",
  PHOTON_PROJECT_ID: `pho_prj_${"0".repeat(26)}`,
  PHOTON_AGENT_USER_ID: `pho_usr_${"1".repeat(26)}`,
  PHOTON_WEBHOOK_SECRET: "whsec_example",
  PUBLIC_BASE_URL: "https://haven.example.com/",
};

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env, "/repo");
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
};

describe("loadConfig", () => {
  it("defaults every integration to mock and the model to Gemini 2.5 Flash-Lite", () => {
    const config = loadConfig(base, "/repo");
    expect(config.photon.mode).toBe("mock");
    expect(config.llm.mode).toBe("mock");
    expect(config.llm.model).toBe("gemini-2.5-flash-lite");
    expect(config.port).toBe(8787);
    expect(config.allowedOrigins).toBe("*");
    expect(config.databasePath).toBe(path.resolve("/repo", "data/haven.db"));
  });

  it("treats empty optional values as unset", () => {
    const config = loadConfig({ ...base, PHOTON_API_KEY: "", LLM_API_KEY: "  " }, "/repo");
    expect(config.photon.apiKey).toBeUndefined();
    expect(config.llm.apiKey).toBeUndefined();
  });

  it("requires a pairing code", () => {
    expect(problems({}).join()).toContain("HAVEN_PAIRING_CODE");
    expect(problems({ HAVEN_PAIRING_CODE: "short" }).join()).toContain("at least 8");
  });

  it("refuses any model other than gemini-2.5-flash-lite", () => {
    expect(problems({ ...base, LLM_MODEL: "gpt-4o-mini" }).join()).toContain(
      "gemini-2.5-flash-lite",
    );
    expect(problems({ ...base, LLM_MODEL: "gemini-2.5-flash" }).length).toBeGreaterThan(0);
  });

  it("requires credentials for live Photon", () => {
    const found = problems({ ...base, PHOTON_MODE: "live" }).join("\n");
    for (const name of [
      "PHOTON_API_KEY",
      "PHOTON_PROJECT_ID",
      "PHOTON_WEBHOOK_SECRET",
      "PUBLIC_BASE_URL",
      "HAVEN_PAIRING_CODE",
    ]) {
      expect(found).toContain(name);
    }
  });

  it("needs an agent user ID only for a dedicated line", () => {
    const { PHOTON_AGENT_USER_ID: _agent, ...shared } = live;
    expect(loadConfig(shared, "/repo").photon.lineMode).toBe("shared");
    expect(problems({ ...shared, PHOTON_LINE_MODE: "dedicated" }).join()).toContain(
      "PHOTON_AGENT_USER_ID",
    );
  });

  it("validates the line number and wearer name", () => {
    expect(problems({ ...base, PHOTON_LINE_NUMBER: "628-316-7976" }).join()).toContain(
      "PHOTON_LINE_NUMBER",
    );
    expect(problems({ ...base, HAVEN_WEARER_NAME: "x".repeat(41) }).join()).toContain(
      "HAVEN_WEARER_NAME",
    );
    expect(loadConfig({ ...base, HAVEN_WEARER_NAME: " Jaden " }, "/repo").wearerName).toBe("Jaden");
  });

  it("accepts a complete live configuration and trims the base URL", () => {
    const config = loadConfig(live, "/repo");
    expect(config.photon.mode).toBe("live");
    expect(config.publicBaseUrl).toBe("https://haven.example.com");
  });

  it("rejects the example pairing code in live mode", () => {
    expect(problems({ ...live, HAVEN_PAIRING_CODE: EXAMPLE_PAIRING_CODE }).join()).toContain(
      "HAVEN_PAIRING_CODE",
    );
  });

  it("requires an API key for live LLM", () => {
    expect(problems({ ...base, LLM_MODE: "live" }).join()).toContain("LLM_API_KEY");
  });

  it("parses an origin allowlist", () => {
    const config = loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.test, https://b.test" }, "/");
    expect(config.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("never includes secrets in the loggable summary", () => {
    const summary = JSON.stringify(describeConfig(loadConfig(live, "/repo")));
    expect(summary).not.toContain("pho_sk_example");
    expect(summary).not.toContain("whsec_example");
    expect(summary).not.toContain(live.HAVEN_PAIRING_CODE);
  });
});
