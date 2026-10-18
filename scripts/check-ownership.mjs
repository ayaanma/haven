#!/usr/bin/env node
// Verify that a branch only touches files its agent owns.
//
//   npm run check:ownership -- --agent agent2              # vs origin/main, incl. uncommitted
//   npm run check:ownership -- --agent agent3 --base main
//   npm run check:ownership -- --who apps/api/src/routes/audio.ts
//   npm run check:ownership -- --list
//
// Exit code 1 lists every file outside the agent's ownership. Foundation-owned files
// (contracts, wiring, root config, docs) must be changed through a proposal instead:
// see docs/INTEGRATION.md § Proposing a contract change.
import { execFileSync } from "node:child_process";
import { AGENTS, FOUNDATION, ownerOf } from "./ownership.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};

if (args.includes("--list")) {
  for (const [agent, { title, paths }] of Object.entries(AGENTS)) {
    console.log(`${agent}  ${title}`);
    for (const p of paths) console.log(`    ${p}`);
  }
  console.log(`${FOUNDATION}  everything else`);
  process.exit(0);
}

const who = flag("--who");
if (who !== undefined) {
  console.log(`${who}: ${ownerOf(who)}`);
  process.exit(0);
}

const agent = flag("--agent");
if (!agent || !(agent in AGENTS || agent === FOUNDATION)) {
  console.error(
    `Usage: --agent <${[...Object.keys(AGENTS), FOUNDATION].join("|")}> [--base <ref>]`,
  );
  process.exit(2);
}
const base = flag("--base") ?? "origin/main";

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const mergeBase = git("merge-base", base, "HEAD")[0];
const changed = new Set([
  ...git("diff", "--name-only", `${mergeBase}...HEAD`),
  ...git("diff", "--name-only"),
  ...git("diff", "--name-only", "--cached"),
  ...git("ls-files", "--others", "--exclude-standard"),
]);

const violations = [...changed].filter((file) => ownerOf(file) !== agent);
if (violations.length === 0) {
  console.log(`OK: ${changed.size} changed file(s), all owned by ${agent}.`);
  process.exit(0);
}
console.error(`${violations.length} file(s) outside ${agent}'s ownership:`);
for (const file of violations) console.error(`  ${file}  (owner: ${ownerOf(file)})`);
console.error(
  "Revert them, or propose the change (docs/INTEGRATION.md § Proposing a contract change).",
);
process.exit(1);
