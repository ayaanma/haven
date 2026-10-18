// End-to-end smoke test in the Even Hub simulator (headless automation API, simulator ≥ 0.7.1):
//   1. serves the production build with `vite preview`
//   2. launches evenhub-simulator with --automation-port
//   3. waits for the app's ready marker, checks the HUD is blank (no lit pixels)
//   4. sends a click and checks the app received exactly one single press
//   5. sends a double click and checks the app saw it and requested the system exit dialog
//
//   npm run sim:smoke                                   (builds first)
//   node apps/g2/scripts/sim-smoke.mjs --skip-build     (reuse apps/g2/dist)
// Needs a desktop session: the simulator opens a window. Not run in CI.
// Screenshots land in apps/g2/sim-artifacts/ (gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { appDir, binPath, runNode, startNode } from "./lib.mjs";
import { decodePng, litPixelCount } from "./png.mjs";

const PREVIEW_PORT = 4173;
const AUTOMATION_PORT = Number(process.env.SIM_AUTOMATION_PORT ?? 9898);
const BASE = `http://127.0.0.1:${AUTOMATION_PORT}`;
const READY_MARKER = "[haven:main] ready";
const artifacts = path.join(appDir, "sim-artifacts");
mkdirSync(artifacts, { recursive: true });

const children = [];
const results = [];
const simLog = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill();
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

let sinceId = 0;
const consoleLines = [];
async function pollConsole() {
  const res = await fetch(`${BASE}/api/console?since_id=${sinceId}`);
  const data = await res.json();
  for (const entry of data.entries ?? []) {
    sinceId = Math.max(sinceId, entry.id ?? 0);
    consoleLines.push(String(entry.message ?? JSON.stringify(entry)));
  }
  return consoleLines;
}

async function screenshot(name) {
  const res = await fetch(`${BASE}/api/screenshot/glasses`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(path.join(artifacts, `${name}.png`), buffer);
  return litPixelCount(decodePng(buffer));
}

async function input(action) {
  const res = await fetch(`${BASE}/api/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`input ${action} → ${res.status} ${await res.text()}`);
}

// Count what the workflow received (the controller also logs each event under [haven:input]).
const countLines = (needle) =>
  consoleLines.filter((line) => line.includes(`[haven:app] ${needle}`)).length;

async function main() {
  if (!process.argv.includes("--skip-build")) runNode(binPath("vite", "vite"), ["build"]);

  const preview = startNode(binPath("vite", "vite"), [
    "preview",
    "--port",
    String(PREVIEW_PORT),
    "--strictPort",
    "--host",
    "127.0.0.1",
  ]);
  children.push(preview);
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`)).ok,
    20_000,
    "vite preview",
  );

  const sim = startNode(
    binPath("@evenrealities/evenhub-simulator"),
    [`http://127.0.0.1:${PREVIEW_PORT}/`, "--automation-port", String(AUTOMATION_PORT)],
    { env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" } },
  );
  children.push(sim);
  sim.stdout?.on("data", (d) => simLog.push(String(d)));
  sim.stderr?.on("data", (d) => simLog.push(String(d)));
  process.on("exit", () => writeFileSync(path.join(artifacts, "simulator.log"), simLog.join("")));
  await waitFor(
    async () => (await (await fetch(`${BASE}/api/ping`)).text()).includes("pong"),
    30_000,
    "simulator",
  );

  await waitFor(
    async () => (await pollConsole()).some((l) => l.includes(READY_MARKER)),
    30_000,
    "ready marker",
  );
  check("app booted and created its startup page", true);
  const startupErrors = consoleLines.filter((l) => /startup failed|uncaught|unhandled/i.test(l));
  check("no startup errors in console", startupErrors.length === 0, startupErrors.join(" | "));

  const idleLit = await screenshot("01-idle");
  check("idle HUD is blank", idleLit === 0, `${idleLit} lit pixels`);

  await input("click");
  await sleep(1_200);
  await pollConsole();
  const singles = countLines("input single_press");
  check("click → exactly one single press", singles === 1, `${singles} single presses`);

  await input("double_click");
  await sleep(1_500);
  await pollConsole();
  const doubles = countLines("input double_press");
  const singlesAfter = countLines("input single_press");
  check(
    "double click → double press, no extra single press",
    doubles === 1 && singlesAfter === 1,
    `${doubles} double, ${singlesAfter} single`,
  );
  // Simulator 0.9.5 logs the call but does not draw the system exit dialog into the
  // framebuffer, so assert on its log. Mode 1 is asserted in controller.test.ts.
  const exitLit = await screenshot("02-after-double-click");
  const shutdownCalls = simLog.join("").split("ShutDownPageContainer").length - 1;
  check(
    "double click requests the system exit (ShutDownPageContainer)",
    shutdownCalls === 1,
    `${shutdownCalls} call(s); framebuffer ${exitLit} lit pixels`,
  );

  writeFileSync(path.join(artifacts, "console.log"), `${consoleLines.join("\n")}\n`);
}

try {
  await main();
} catch (error) {
  check("smoke run completed", false, error.message);
  writeFileSync(path.join(artifacts, "console.log"), `${consoleLines.join("\n")}\n`);
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed. Artifacts: ${artifacts}`,
);
process.exit(failed.length === 0 ? 0 : 1);
