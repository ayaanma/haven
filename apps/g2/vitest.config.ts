import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "g2",
    // Logic is tested against fakes in Node; the real bridge only exists in the Even App WebView.
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
