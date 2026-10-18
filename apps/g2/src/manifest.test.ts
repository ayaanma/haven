// Static checks of app.json against the rules in the Even Hub packaging docs
// (https://hub.evenrealities.com/docs/ship/packaging). `npm run pack` runs the
// authoritative validator (evenhub pack); this catches mistakes earlier.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  package_id: string;
  edition: string;
  name: string;
  version: string;
  min_sdk_version: string;
  entrypoint: string;
  permissions: { name: string; desc: string; whitelist?: string[] }[];
  supported_languages: string[];
  [key: string]: unknown;
}

const manifest = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
) as Manifest;

describe("app.json", () => {
  it("has the required fields in the documented formats", () => {
    expect(manifest.package_id).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
    expect(manifest.edition).toBe("202601");
    expect(manifest.name.length).toBeLessThanOrEqual(20);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.entrypoint).toBe("index.html");
    expect(manifest.supported_languages).toEqual(["en"]);
  });

  it("declares exactly the permissions Haven uses", () => {
    const names = manifest.permissions.map((p) => p.name).sort();
    expect(names).toEqual(["g2-microphone", "location", "network"]);
    for (const permission of manifest.permissions) {
      expect(permission.desc.length).toBeGreaterThan(0);
      expect(permission.desc.length).toBeLessThanOrEqual(300);
    }
  });

  it("whitelists full origins only", () => {
    const network = manifest.permissions.find((p) => p.name === "network");
    expect(network?.whitelist?.length).toBeGreaterThan(0);
    for (const origin of network?.whitelist ?? []) {
      expect(new URL(origin).origin).toBe(origin);
    }
  });

  it("does not hand-pin min_app_version (the CLI derives it from --sdk-ver)", () => {
    expect(manifest.min_app_version).toBeUndefined();
  });
});
