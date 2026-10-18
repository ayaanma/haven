// Build Haven and package it as an .ehpk for Even Hub private/beta testing.
//
//   npm run pack -w @haven/g2                    # uses apps/g2/.env.local
//   VITE_HAVEN_API_BASE_URL=https://haven.example.com npm run pack -w @haven/g2
//
// The network whitelist in the packaged manifest is set to the origin of
// VITE_HAVEN_API_BASE_URL, so the build can only call the backend it was built for.
// The committed app.json is never modified.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "vite";
import { appDir, binPath, installedSdkVersion, readManifest, runNode } from "./lib.mjs";

const skipBuild = process.argv.includes("--skip-build");
const output = path.join(appDir, `haven-${readManifest().version}.ehpk`);

const env = { ...loadEnv("production", appDir, "VITE_"), ...process.env };
const apiBaseUrl = env.VITE_HAVEN_API_BASE_URL || "http://localhost:8787";
const apiOrigin = new URL(apiBaseUrl).origin;
if (!apiOrigin.startsWith("https://")) {
  console.warn(
    `[pack] WARNING: ${apiOrigin} is not HTTPS. Use an HTTPS backend for anything beyond local testing.`,
  );
}

const manifest = readManifest();
const network = manifest.permissions.find((p) => p.name === "network");
if (!network) throw new Error("app.json has no network permission");
network.whitelist = [apiOrigin];

const buildDir = path.join(appDir, ".ehpk-build");
mkdirSync(buildDir, { recursive: true });
const manifestPath = path.join(buildDir, "app.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (!skipBuild) runNode(binPath("vite", "vite"), ["build"], { env: { ...process.env, ...env } });

const sdkVersion = installedSdkVersion();
console.log(`[pack] whitelist=${apiOrigin} sdk=${sdkVersion} -> ${path.relative(appDir, output)}`);
runNode(binPath("@evenrealities/evenhub-cli", "evenhub"), [
  "pack",
  manifestPath,
  path.join(appDir, "dist"),
  "-o",
  output,
  "--sdk-ver",
  sdkVersion,
]);
