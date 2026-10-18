// Bundles the API into dist/index.js. Workspace packages (@haven/*) are inlined because
// they ship TypeScript source; npm dependencies stay external and load from node_modules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@haven/"));

await build({
  entryPoints: [here("../src/index.ts")],
  outfile: here("../dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external: [...external, ...external.map((name) => `${name}/*`)],
  logLevel: "info",
});
