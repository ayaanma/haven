import { defineConfig } from "vitest/config";

// One Vitest run covers every workspace. Each workspace's own vitest.config.ts
// defines its project name and environment. Run a single project with
// `npx vitest run --project api` (or contracts, g2, repo).
export default defineConfig({
  test: {
    projects: [
      "packages/contracts",
      "apps/api",
      "apps/g2",
      {
        test: {
          name: "repo",
          include: ["scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
    ],
  },
});
