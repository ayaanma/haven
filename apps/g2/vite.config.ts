import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs: the packaged .ehpk is not served from the domain root.
  base: "./",
  server: {
    // Reachable from the phone for QR sideloading (`npm run qr -w @haven/g2`).
    host: true,
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
