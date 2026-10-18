import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import { AGENTS } from "./scripts/ownership.mjs";

/** Relative import of a sibling module directory, e.g. "../audio" or "../../audio/x". */
const dir = (...names) => `^\\.{1,2}/(.+/)?(${names.join("|")})(/.*)?$`;

const TESTS = ["**/*.test.ts", "**/*.test.mjs", "**/testing/**"];

/**
 * Import boundaries between parallel agents. Modules talk through the interfaces in
 * apps/g2/src/core/interfaces.ts and apps/api/src/lib/interfaces.ts, wired only by the
 * composition roots (core/app-context.ts, src/container.ts). Tests are exempt.
 */
function boundary(name, files, forbidden, message) {
  return {
    name: `haven/boundary/${name}`,
    files,
    ignores: TESTS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...forbidden.map((regex) => ({ regex, caseSensitive: true, message })),
            {
              regex: "(^|/)testing(/|$)",
              caseSensitive: true,
              message: "Test utilities may only be imported from tests.",
            },
          ],
        },
      ],
    },
  };
}

const NO_API_FROM_G2 = "^@haven/api|apps/api";
const NO_G2_FROM_API = "^@haven/g2|apps/g2|@evenrealities/";
const cross =
  "Use the interfaces in core/interfaces.ts (G2) or lib/interfaces.ts (API); do not import another agent's module.";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "apps/g2/.ehpk-build/**",
      "apps/g2/sim-artifacts/**",
      "data/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  {
    files: ["apps/g2/src/**"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // ── G2 ──
  boundary("g2-agent1", AGENTS.agent1.paths, [dir("devices", "audio"), NO_API_FROM_G2], cross),
  boundary(
    "g2-agent3",
    AGENTS.agent3.paths.filter((p) => p.startsWith("apps/g2/")),
    [dir("hud", "workflows", "services", "onboarding", "audio", "main"), NO_API_FROM_G2],
    cross,
  ),
  boundary(
    "g2-agent4",
    AGENTS.agent4.paths.filter((p) => p.startsWith("apps/g2/")),
    [dir("hud", "workflows", "services", "onboarding", "devices", "main"), NO_API_FROM_G2],
    cross,
  ),
  {
    ...boundary(
      "g2-core",
      ["apps/g2/src/core/**"],
      [
        dir("hud", "workflows", "services", "onboarding", "devices", "audio", "main"),
        NO_API_FROM_G2,
      ],
      "Only core/app-context.ts (the composition root) may import feature modules.",
    ),
    ignores: [...TESTS, "apps/g2/src/core/app-context.ts"],
  },
  boundary("g2-composition", ["apps/g2/src/core/app-context.ts"], [NO_API_FROM_G2], cross),

  // ── API ──
  boundary("api-agent2", AGENTS.agent2.paths, [dir("context", "audio"), NO_G2_FROM_API], cross),
  boundary(
    "api-agent3",
    AGENTS.agent3.paths.filter((p) => p.startsWith("apps/api/")),
    [dir("alerts", "photon", "contacts", "audio", "routes"), NO_G2_FROM_API],
    cross,
  ),
  boundary(
    "api-agent4",
    AGENTS.agent4.paths.filter((p) => p.startsWith("apps/api/")),
    [dir("alerts", "photon", "contacts", "context"), NO_G2_FROM_API],
    cross,
  ),
  boundary(
    "api-foundation",
    ["apps/api/src/lib/**", "apps/api/src/db/**"],
    [dir("alerts", "photon", "contacts", "context", "audio", "routes"), NO_G2_FROM_API],
    "Foundation primitives must not depend on feature modules.",
  ),
  boundary(
    "api-composition",
    [
      "apps/api/src/app.ts",
      "apps/api/src/container.ts",
      "apps/api/src/index.ts",
      "apps/api/src/routes/auth.ts",
    ],
    [NO_G2_FROM_API],
    cross,
  ),

  // ── Contracts: platform-neutral, no app or SDK dependencies ──
  boundary(
    "contracts",
    ["packages/contracts/src/**"],
    ["^@haven/(api|g2)", "(^|/)apps/", "^hono", "^@evenrealities/", "^node:"],
    "Contracts must stay platform-neutral (Zod + TypeScript only).",
  ),
);
