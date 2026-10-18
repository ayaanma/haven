import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "api",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // node:sqlite prints an ExperimentalWarning on Node 24; it is expected.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
