// Shared helpers for the G2 dev scripts. Cross-platform: runs package binaries through
// `node <bin>` instead of relying on shell shims.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

/** Absolute path to a package's bin script (packages without an exports map). */
export function binPath(packageName, binName) {
  const pkgJson = require.resolve(`${packageName}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName ?? Object.keys(pkg.bin)[0]];
  return path.join(path.dirname(pkgJson), bin);
}

/** Installed Even Hub SDK version (its exports map hides package.json). */
export function installedSdkVersion() {
  const entry = require.resolve("@evenrealities/even_hub_sdk");
  return JSON.parse(readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8"))
    .version;
}

export function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    cwd: appDir,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} ${args.join(" ")} exited with ${result.status}`);
  }
}

export function startNode(script, args, options = {}) {
  return spawn(process.execPath, [script, ...args], { cwd: appDir, ...options });
}

export function readManifest() {
  return JSON.parse(readFileSync(path.join(appDir, "app.json"), "utf8"));
}
