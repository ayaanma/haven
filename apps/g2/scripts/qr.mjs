// Print a QR code that sideloads the running Vite dev server onto real G2 glasses.
//   Terminal 1: npm run dev:g2      Terminal 2: npm run qr -w @haven/g2 [-- --ip 192.168.1.20]
// Scan it from the Even Realities app (Even Hub tab → Scan QR, Developer Mode enabled).
import os from "node:os";
import { binPath, runNode } from "./lib.mjs";

const ipFlag = process.argv.indexOf("--ip");
const lanIp =
  (ipFlag > -1 ? process.argv[ipFlag + 1] : undefined) ??
  Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface && iface.family === "IPv4" && !iface.internal)?.address;

if (!lanIp) {
  console.error("Could not determine a LAN IPv4 address; pass --ip <address>.");
  process.exit(1);
}

const url = `http://${lanIp}:5173`;
console.log(`[qr] ${url}`);
console.log(
  `[qr] The phone must also reach the API: set VITE_HAVEN_API_BASE_URL=http://${lanIp}:8787 in apps/g2/.env.local`,
);
runNode(binPath("@evenrealities/evenhub-cli", "evenhub"), ["qr", "--url", url]);
