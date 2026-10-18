import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENTS, FOUNDATION, globToRegExp, ownerOf } from "./ownership.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  "data",
  "sim-artifacts",
  ".ehpk-build",
  "coverage",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(path.relative(root, full).replace(/\\/g, "/"));
  }
  return out;
}

const files = [...walk(path.join(root, "apps")), ...walk(path.join(root, "packages"))];

describe("ownership map", () => {
  it("matches the documented assignments", () => {
    expect(ownerOf("apps/g2/src/main.ts")).toBe("agent1");
    expect(ownerOf("apps/g2/src/workflows/sos.ts")).toBe("agent1");
    expect(ownerOf("apps/api/src/routes/photon-webhooks.ts")).toBe("agent2");
    expect(ownerOf("apps/api/src/photon/live/client.ts")).toBe("agent2");
    expect(ownerOf("apps/g2/src/devices/imu.ts")).toBe("agent3");
    expect(ownerOf("apps/api/src/context/gemini.ts")).toBe("agent3");
    expect(ownerOf("apps/g2/src/audio/recorder.ts")).toBe("agent4");
    expect(ownerOf("apps/api/src/routes/audio.ts")).toBe("agent4");
  });

  it("keeps shared contracts, wiring, and primitives with the foundation", () => {
    for (const file of [
      "packages/contracts/src/alerts.ts",
      "apps/api/src/app.ts",
      "apps/api/src/container.ts",
      "apps/api/src/routes/auth.ts",
      "apps/api/src/lib/interfaces.ts",
      "apps/api/src/db/migrations.ts",
      "apps/g2/src/core/interfaces.ts",
      "apps/g2/src/core/input/controller.ts",
      "apps/g2/app.json",
      "package.json",
      "package-lock.json",
    ]) {
      expect(ownerOf(file), file).toBe(FOUNDATION);
    }
  });

  it("gives every file exactly one owner", () => {
    for (const file of files) {
      const owners = Object.entries(AGENTS).filter(([, { paths }]) =>
        paths.some((glob) => globToRegExp(glob).test(file)),
      );
      expect(owners.length, file).toBeLessThanOrEqual(1);
    }
  });

  it("has a placeholder file for every agent area", () => {
    for (const [agent, { paths }] of Object.entries(AGENTS)) {
      for (const glob of paths) {
        expect(
          files.some((file) => globToRegExp(glob).test(file)),
          `${agent}: ${glob}`,
        ).toBe(true);
      }
    }
  });
});
